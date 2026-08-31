# Gram runs three isolation tiers — containers, throwaway VMs, kept VMs

Gram is the personal laptop for tasting Linux distros and for running random dev projects / potentially unsafe binaries. The kernel-sharing boundary is load-bearing: containers share the host kernel and are wrong for untrusted code, VMs do not. Lifetime/ergonomics is the second split: throwaways should be `rm -rf` deletable with no daemon state, keepers need snapshots/clones and a manager.

We keep all three, each in its tier (threat model §2 is casual-sketchy, not malware analysis):

- **Container** — trusted code, missing deps, language toolchains. `<1s` start, shares kernel.
- **Throwaway VM** (`quickemu` + `virt-viewer` in the same module) — per-user `quickget && quickemu --vm`, qcow2 in `~/quickemu`, delete directory to nuke. Real KVM VM, SLIRP user networking, no daemon, no libvirt state.
- **Kept VM** (`libvirtd` + `virt-manager`, same module) — daemon-managed `qemu:///system` with hardening: `qemu.runAsRoot = false` (libvirt strongly recommends against root), `namespaces = ["mount"]` restoring upstream's mount-namespace isolation that NixOS otherwise disables, `swtpm.enable` opt-in per guest, `vhostUserPackages = [ virtiofsd ]` for fast shares. A declarative isolated network `sandbox` (`virbr1` `192.168.210.0/24`, no `<forward>` per `libvirt.org/formatnetwork.html`) is defined via `systemd.services.libvirt-sandbox-net` — `default` NAT stays for normal guests, sketchy kept guests attach to `sandbox`.

Why not one tool: `libvirt`-only makes every throwaway a 10-click wizard with manual ISO hunting; `quickemu`-only has no snapshot/clone UI and no daemon to remember a VM after reboot; containers-only fail the isolation requirement for untrusted binaries. Three stacks look redundant without this note; they are not.

Rejected: single-tier consolidation (libvirt-only, quickemu-only), GNOME Boxes (GNOME deps on Hyprland), `firecracker`/`cloud-hypervisor`/`crosvm` (Linux-guest or headless only, fail arbitrary-OS requirement per `docs/research/isolated-vms-on-nixos.md:25-27`), VFIO passthrough (explicitly out of scope, conflicts with ADR 0003).

Consequences: `virtualization.nix` is gram-only (only `hosts/gram/config.nix:15` imports it), so scope is isolated. Enabling all three costs one extra daemon (`libvirtd`), one oneshot for `sandbox`, and two user packages; security posture on gram is mainline mitigations (CachyOS BORE kernel verified without `mitigations=` weakening) plus per-guest choices documented in `docs/vm-workflows.md` (isolated vs NAT, memballoon off for secrets, optional `kvm-intel.vmentry_l1d_flush=always` for paranoid runs).

Status: accepted
