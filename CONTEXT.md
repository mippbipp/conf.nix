# Configuration Flake

Declarative NixOS and home-manager configuration for the fleet in `hosts/`.

## Hosts

- **gram**: desktop machine (Secure Boot via lanzaboote).
- **harpe**: WSL guest on the personal laptop.
- **warpe**: WSL guest on the work laptop; carries the company CA trust.
- **pewter**: always-on Oracle ARM server; tailnet exit node and remote workspace host.
- **hector**: Work host — EC2 dev machine in the work account, reachable over tailnet.
- **midd**: Windows host; only `hosts/midd/setup.ps1`, not a NixOS config.

## Hector isolation

**Work host**:
The fleet member that lives in the work AWS account. Its disk and RAM can be snapshotted by work admins, so it holds no personal secrets or shared age identity.
_Avoid_: work machine, work box

**Personal host**:
A fleet member that may hold the shared age identity and personal secrets. `warpe` counts as personal even though it runs on the work laptop.
_Avoid_: personal machine (ambiguous)

**Tag isolation**:
The tailnet grants that restrict `hector` to `tag:work`. Only `warpe` and `gram` can reach it, and it can only reach `pewter` and the internet.
_Avoid_: ACL isolation (generic)

**AWS resource namespace**:
The tag and network scope that isolates `hector`'s AWS resources from coworkers'.
_Avoid_: sandbox, k8s namespace

**Instance profile**:
The IAM role attached to `hector` that grants its AWS abilities without embedded keys.
_Avoid_: role profile, admin role

## Gram GPU policy

**iGPU**:
The Intel UHD Graphics that renders everything by default.
_Avoid_: integrated gpu, intel gpu

**dGPU**:
The NVIDIA RTX 3060 Mobile that renders only explicitly offloaded apps.
_Avoid_: dedicated gpu, nvidia gpu

**Offload launch**:
Starting an app with `__NV_PRIME_RENDER_OFFLOAD` so it renders on the dGPU while the session stays on the iGPU.
_Avoid_: gpu switching

## Isolation tiers (gram)

**Kept VM**:
A libvirtd VM with persistent state and a manager entry; survives reboots and supports snapshots.
_Avoid_: persistent vm

**Throwaway VM**:
A quickemu VM whose lifetime is its directory; removing the directory removes the VM.
_Avoid_: ephemeral vm

**Isolated network**:
A libvirt network with no forwarding; guests on it cannot reach the host LAN or tailnet.
_Avoid_: sandbox network

**Container**:
A podman/distrobox workload sharing the host kernel; for trusted code where kernel sharing is acceptable.
_Avoid_: docker container

## Build

**nrs**:
The rebuild command for this flake. It switches the current host by default and `nrs <host>` for another, substituting from Attic; `nrs --push` publishes.
_Avoid_: rebuild, deploy

## Globals

**Globals**:
The single source for facts that outlive any one module — identity, DNS profile, and a Host record per machine. Threaded as module arguments, never imported directly.
_Avoid_: variables, constants

**Host record**:
A machine's entry in Globals that other machines need about it — endpoints, keys, and Role flags. Not the machine's own config.
_Avoid_: host config

**Role flag**:
A boolean capability on a Host record that shared modules branch on instead of comparing host names.
_Avoid_: feature flag

## Flake update pipeline

**Attic cache**:
The persistent Nix cache on pewter at `cache.mippbipp.com/fleet`. Hosts substitute from it; the Build gate, the Deployer, and `nrs --push` publish to it.
_Avoid_: build cache (ambiguous)

**Build gate**:
The required CI check that builds every host's toplevel before main can merge. It enforces "main is always buildable".
_Avoid_: CI (generic)

**Updater**:
The pewter automation that bumps `flake.lock` weekly and maintains the single accumulating update PR.
_Avoid_: cron job, bot

**Deployer**:
The pewter automation that pulls main weekly and switches pewter onto it after verifying every `build <host>` check.
_Avoid_: CD

**Health gate**:
Post-switch probes that decide whether a new generation stays or gets rolled back.
_Avoid_: smoke test

**Watchdog**:
The monthly alarm that fails when updates stop flowing.
_Avoid_: heartbeat

## Theming

**Stylix**:
The Nix theming framework that sets palette, fonts, and cursor and propagates via Home Manager. Targets auto-enable; those with custom theming are disabled.
_Avoid_: theme manager (generic)

**Base16 scheme**:
A 16-color palette (`base00`–`base0F`) from `base16-schemes`.
_Avoid_: color scheme (ambiguous with vim colorscheme)

**Manual sync**:
Keeping the nvim colorscheme equal to the Stylix `base16Scheme` by hand. Chosen for nvim portability. See ADR 0016.
_Avoid_: auto sync

**Tinted-nvim**:
The plugin that provides `base16-*` schemes for LazyVim.
_Avoid_: base16-nvim (different plugin)

## AI

**Agent provider**:
A CLI agent that t3code discovers on its PATH and drives.
_Avoid_: agent (ambiguous)

**Control surface**:
t3code's role — it doesn't run agents itself, it drives providers.
_Avoid_: GUI, frontend

**Provider flag**:
An `enable*` toggle that decides which providers are wrapped into the t3code PATH.
_Avoid_: option

**Bundled provider**:
A provider shipped unconditionally in a package's PATH; llm-agents bundles all five, nixpkgs bundles only flagged ones.
_Avoid_: built-in provider

**Remote workspace**:
A t3 server on a different machine than the client. Projects and sessions live on the server; clients are control surfaces.
_Avoid_: remote agent

**Tailnet transport**:
How clients reach the remote workspace — Tailscale Serve HTTPS with the backend loopback-bound.
_Avoid_: tunnel

**Pairing**:
The one-time token exchange between a client and a t3 server.
_Avoid_: login, auth

## DNS layering

**Host-local resolver**:
The host's `systemd-resolved` that forwards `~.` to NextDNS over DoT. It survives `tailscaled` being down and is the fallback when the tailnet global is absent.
_Avoid_: local dns, system dns

**Tailnet global nameserver**:
The tailnet-wide nameserver pushed to clients that accept DNS. For NextDNS it maps to the profile via `nodeAttrs` over DoH.
_Avoid_: global dns

**MagicDNS**:
Tailscale's `100.100.100.100` that answers `*.ts.net`. Wired automatically on most hosts, split-wired on `warpe`.
_Avoid_: quad100

**Override local DNS**:
The flag that makes clients replace their local resolver with the tailnet global. Required for iOS, disabled on `warpe`.
_Avoid_: override dns

## Things sync

**things folder**:
The `~/things` directory synced between `gram` and `pewter` via Syncthing; the single source for personal documents. See ADR 0014.
_Avoid_: synced folder

## Control plane

**Control plane**:
Externally owned coordination state that outlives any device — tailnet policy, DNS, Cloudflare zone, and OCI infra. Devices only carry interface flags.
_Avoid_: server config, backend config

**Tailnet policy file**:
The single policy that defines tags, grants, and `nodeAttrs`. Terraform is source of truth; console edits are overwritten.
_Avoid_: ACL file

**Cloudflare zone**:
The DNS zone for `mippbipp.com`. Owned by OpenTofu.
_Avoid_: domain config

**External infra**:
The OCI network and compute backing pewter.
_Avoid_: cloud config
