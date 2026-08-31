# VM workflows on gram — which tier, which command

Cheatsheet for the three tiers defined in ADR 0013 and `CONTEXT.md` Isolation tiers.

## Choose the tier

| Need | Tier | Isolation | Lifetime |
|---|---|---|---|
| Missing dep, language toolchain, trusted project | Container / distrobox | shares host kernel | seconds |
| Taste an ISO and throw it away | **Throwaway VM** (`quickemu`) | real KVM VM | minutes |
| Keep the OS, need snapshots/clones/UI, sketchy GUI app you revisit | **Kept VM** (`libvirtd`) | real KVM VM, hardened | weeks |

Rule: trusted code may live in a container; untrusted code must be a VM. `quickemu` and kept VMs differ only in management, not isolation.

## Container (trusted)

```bash
distrobox create --name node20 --image node:20
distrobox enter node20
# ... work, exit ...
distrobox rm node20          # or keep it
podman run --rm -it archlinux bash
```

See `distrobox/distrobox.conf` for shared `/nix/store` volumes.

## Throwaway VM (quickemu)

```bash
quickget --help                          # lists ~100 OSes: alma, archlinux, debian, fedora, nixos, windows, etc.
quickget nixos unstable                  # downloads ISO + writes nixos/nixos.conf
quickemu --vm nixos/nixos.conf           # boots; SPICE window appears

# Omarchy (not in quickget as of 2026-04):
quickget archlinux
quickemu --vm archlinux/archlinux.conf  # then run omarchy installer inside the guest
# — or — point quickemu at a manually downloaded omarchy ISO by editing the .conf's iso= line

qemu-img snapshot -c clean ~/quickemu/nixos/disk.qcow2   # before sketchy binary
qemu-img snapshot -a clean ~/quickemu/nixos/disk.qcow2   # after
rm -rf ~/quickemu/nixos                                      # nuke
```

Notes: throwaway VMs use SLIRP user networking (guest can reach internet, host not bridged). No `sandbox` network needed — that is for kept VMs. Snapshots are qcow2-internal; `qcow2` default is correct for throwaways.

## Kept VM (libvirtd + virt-manager)

Hardened libvirtd: `qemu.runAsRoot = false`, restores mount namespace, enables `swtpm`, adds `virtiofsd`, defines isolated network `sandbox` (`virbr1` `192.168.210.0/24`, no `<forward>`).

### Create

1. `virt-manager` → File → New VM → Local install media → pick ISO → OS type → RAM/CPU → Create a disk image (`qcow2`).
2. On the final screen tick **Customize before install**:
   - **Overview → Firmware**: `UEFI` (`OVMF`) when the guest needs it; guest Secure Boot available but leave off unless you plan key enrollment (virtio-win drivers are attestation-signed, not WHQL — guest SB may reject them).
   - **CPUs → Model**: `Copy host CPU configuration` (host-passthrough) — fastest, migration irrelevant on a single laptop.
   - **NIC**: `Virtual network 'default': NAT` for normal guests; `Virtual network 'sandbox': isolated` for sketchy ones (no host LAN/tailnet reach). Verify `sandbox` exists: `virsh net-info sandbox` — if not active, `systemctl status libvirt-sandbox-net`.
   - **Disk → Advanced**: `Bus: Virtio`, `Cache: writeback` for `qcow2` (or `none` + `IO: io_uring` for raw images).
   - **Add Hardware → TPM** → `Emulated` (`TIS`/`CRB`) only if OS demands it (Windows 11). Each TPM gets persistent state—don't add spuriously.
   - Remove unused hardware (tablet, sound, USB controller) if you want a smaller attack surface.
3. Begin install. After install, install guest agents: `spice-vdagent` (Linux), `virtio-win` drivers (Windows) from `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/`.

### Operate

```bash
virsh list --all
virsh snapshot-create-as myvm clean --description "before sketchy install"
virsh snapshot-list myvm
virsh snapshot-revert myvn clean
virsh snapshot-delete myvm clean
virsh destroy myvm; virsh undefine myvm --remove-all-storage   # nuke

# Share a host directory (fast path):
#  virt-manager → Add Hardware → Filesystem → Driver: virtiofs → Source: /home/<you>/share → Target: hostshare
#  inside guest (Linux):  mount -t virtiofs hostshare /mnt/host
```

### Per-VM checklists (no global knob — set in virt-manager per VM)

Security for sketchy kept VMs: attach `sandbox` network, no SPICE USB redirection (module `spice-usb-redirection` intentionally not enabled — pass individual devices only when needed), disable memballoon if handling secrets (`XML → Memory → Balloon: None` — pages otherwise return to host pool), keep seccomp on (default).

Performance for keepers: virtio everywhere (disk/net/fs), NIC `vhost=on` + `queues` if exposed, `packed=on` queues, host-passthrough CPU + pinning via `CPUs → Pinning` only for the one long-running hungry guest, skip hugepages (fights `zswap.max_pool_percent=20`), prefer `virtiofs` over 9P for shares (`virtiofsd` already in `vhostUserPackages`).

## Verify after `nrs`

```bash
virsh net-info default   # Active: yes
virsh net-info sandbox   # Active: yes, Bridge: virbr1
ps -o user,comm -C qemu-system-x86_64  # USER should be qemu-libvirtd, not root (for new VMs)
virsh dumpxml myvm | grep -E "cpu mode|cputune|memballoon|tpm|filesystem"
```

- `sandbox` bridge `virbr1` must not collide with home `192.168.1.0` — chosen `192.168.210.0/24`.
- CachyOS kernel on gram keeps mainline mitigations (no `mitigations=`); for paranoid runs you may add `boot.kernelParams = [ "kvm-intel.vmentry_l1d_flush=always" ]` and rebuild, but default `cond` is correct for casual-sketchy (ADR 0013).
- Existing VMs with root-owned images: `chown` needed after the `runAsRoot` flip — you have none to migrate per Q3.
