# Configuration Flake

Declarative NixOS/home-manager configuration for the host machines (gram, harpe, warpe, pewter, midd).

## Hosts

- **gram**: the desktop machine (Secure Boot via lanzaboote).
- **harpe**: the WSL guest on the personal laptop.
- **warpe**: the WSL guest on the work laptop; carries the company CA trust config in `hosts/warpe/work.nix`.
- **pewter**: the always-on Oracle ARM server; tailnet exit node and host of the remote workspace.
- **midd**: the Windows host — only `hosts/midd/setup.ps1`, not a NixOS config.

## Gram GPU policy

**iGPU**:
The Intel UHD Graphics in gram (card1); renders everything by default.
_Avoid_: integrated gpu, intel gpu

**dGPU**:
The NVIDIA RTX 3060 Mobile in gram (card0); renders only what is explicitly offloaded.
_Avoid_: dedicated gpu, nvidia gpu

**Offload launch**:
Starting an app with `__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia` so it renders on the dGPU while the session stays on the iGPU.
_Avoid_: switch to the gpu, gpu switching

## Isolation tiers (gram)

**Kept VM**:
A libvirtd-managed VM with persistent state and a virt-manager entry; survives reboots and supports snapshots/clones.
_Avoid_: persistent vm, managed vm

**Throwaway VM**:
A per-user quickemu VM whose lifetime is the directory it lives in; removing the directory removes the VM.
_Avoid_: ephemeral vm, quickemu vm

**Isolated network**:
A libvirt `sandbox` network with no `<forward>` element; guests on it cannot reach the host LAN or tailnet.
_Avoid_: sandbox network, disconnected network

**Container**:
A podman/distrobox workload sharing the host kernel; for trusted code where kernel sharing is acceptable.
_Avoid_: docker container, toolbox

## Build

`nrs`: rebuilds and switches this machine from this flake — current host by default, `nrs <host>` for another. It substitutes from the fleet Attic cache; `nrs --push` explicitly publishes the resulting closure. See `modules/hm/devenv/scripts/nrs.nix`.

## Globals

**Globals**:
The single source for facts that outlive any one module: the user's identity, the fleet's DNS profile, and a Host record per machine (`modules/globals.nix`). Threaded through the flake as module arguments — modules never import it directly.
_Avoid_: variables, hardcoded values, constants

**Host record**:
A machine's entry in Globals: the endpoints, keys, and identifiers another machine might need about it (SSH port, LUKS endpoint, public key, sync ID) plus its Role flags. Not the machine's own config, which lives in `hosts/<name>/`.
_Avoid_: host config, machine settings

**Role flag**:
A boolean capability on a Host record (exit node, remote builder) that shared modules branch on instead of comparing host names. Where an existing NixOS option already carries the fact (wsl.enable), the option wins.
_Avoid_: feature flag, per-host toggle

## Flake update pipeline

**Attic cache**:
The persistent Nix binary cache hosted on pewter at `https://cache.mippbipp.com/fleet`. All NixOS hosts use it for substitution; GitHub-hosted Build gate runners and explicit local `nrs --push` runs publish authenticated closures.
_Avoid_: build cache (ambiguous), GitHub cache

**Build gate**:
The required CI check that builds every NixOS host's toplevel before a commit can reach main; the enforcement of "main is always buildable". See ADR 0009.
_Avoid_: CI (generic), tests

The `main` branch ruleset requires `build gram`, `build harpe`, `build pewter`,
and `build warpe` to pass before a pull request can merge.

**Updater**:
The pewter-side automation that bumps flake.lock and maintains the single accumulating update PR.
_Avoid_: cron job, bot, auto-update

**Deployer**:
The pewter-side automation that pulls main and switches pewter onto it daily.
_Avoid_: CD, deployment script

**Health gate**:
The post-switch probes that decide whether a new generation stays or gets rolled back.
_Avoid_: smoke test, verification

**Watchdog**:
The weekly stale-lock alarm that fails loudly when updates stop flowing, catching silent Updater death.
_Avoid_: dead-man switch, heartbeat

## Config live-editing

- **out-of-store config**: a config file tracked in this repo that home-manager symlinks into place instead of writing from the store, so edits take effect without a rebuild. Precedent: the nvim submodule, the hyprland Lua root.
- **hyprland Lua root**: the out-of-store `hyprland.lua` that Hyprland loads as its config (Lua replaced hyprlang in 0.55; hyprlang is deprecated and removed in 0.57).
- **host bindings**: the small Nix-generated values file that feeds store-dependent paths (built scripts) into the Lua root; the seam between rebuild-owned and live-edited config.

## AI

**Agent provider**:
A CLI agent (opencode, codex, claude-code, grok, cursor-agent) that t3code discovers on its PATH and drives.
_Avoid_: agent (ambiguous), provider (too generic)

**Control surface**:
t3code's role in this setup — it doesn't run agents itself, it drives agent providers.
_Avoid_: GUI, frontend

**Provider flag**:
An `enable*` toggle on nixpkgs' t3code package that decides which agent providers are wrapped into its PATH.
_Avoid_: option, switch

**Bundled provider**:
An agent provider shipped in a package's PATH unconditionally; llm-agents' t3code bundles all five, nixpkgs' t3code bundles only flag-enabled ones.
_Avoid_: built-in provider

**Remote workspace**:
A t3 server running on a different machine than the client — on this tailnet, pewter's always-on server. Projects, files, git state, terminals, and provider sessions live on the server host; clients are control surfaces.
_Avoid_: remote agent, remote machine

**Tailnet transport**:
How clients reach the remote workspace — Tailscale Serve HTTPS at `https://pewter.<tailnet>.ts.net/` with the backend loopback-bound, instead of raw HTTP on the tailnet IP.
_Avoid_: tunnel, relay

**Pairing**:
The one-time token exchange between a client and a t3 server (`t3 pair`); after pairing, access is session-based.
_Avoid_: login, auth (t3's `t3 auth` manages sessions separately)

## DNS layering

**Host-local resolver**:
`systemd-resolved` on a NixOS host (`modules/system/config/resolved.nix`) that forwards `~.` via strict `DNSOverTLS=yes` to the shared NextDNS profile `7b9721` with per-host SNI `${host}-7b9721.dns.nextdns.io` (`modules/globals.nix:4`). Survives `tailscaled` being down; only live when `wsl.wslConf.network.generateResolvConf=false` on WSL. Not the same as the tailnet global.
_Avoid_: local dns, system dns

**Tailnet global nameserver**:
The `tailscale_dns_configuration.global` (`terraform/tailscale/main.tf:47`) nameservers + `override_local_dns`. Pushed by the coordination server to every tailnet client that accepts DNS (`--accept-dns`). For NextDNS, the only correct transport is DNS-over-HTTPS: the sentinel address is the profile's linked IPv6 (`2a07:a8c0::7b:9721` for `7b9721`) and the Tailnet policy file `nodeAttrs` maps `nextdns:7b9721` to that profile. Bare `45.90.28.0` without the attr is plaintext UDP 53 and is blocked on most networks.
_Avoid_: global dns, tailnet dns

**MagicDNS**:
Tailscale's `100.100.100.100` that answers `*.ts.net` / the tailnet's `MagicDNSSuffix`. On `gram`/`pewter` it is wired automatically by `tailscaled`'s `systemd-resolved` integration when `magic_dns=true`; on `warpe` (which sets `isWorkPc -> --accept-dns=false` in `modules/system/config/tailscale/default.nix:38`) it is wired explicitly by `modules/system/config/tailscale/split-dns.nix:21` `resolvectl domain tailscale0 "~ts.net"` + `default-route false` so only `ts.net` goes via the tunnel.
_Avoid_: magic dns (generic), quad100

**Override local DNS**:
The `override_local_dns` flag in `tailscale_dns_configuration` (`terraform/tailscale/main.tf:49`). When true, clients that accept DNS replace their local resolver for `~.` with the tailnet global. Required for iOS per ADR 0005 — without it iOS falls back to its local resolver and gets `NXDOMAIN` for `pewter.<tailnet>.ts.net`. `warpe` opts out (`--accept-dns=false`) because company WiFi blocks NextDNS even over DoH.
_Avoid_: override dns

## Things sync

**things folder**:
The `~/things` directory on gram and pewter synced via Syncthing (`sendreceive`, tailnet-only); the single source of truth for personal documents. See ADR 0014.
_Avoid_: synced folder, shared folder

## Control plane

**Control plane**:
Externally owned coordination state that outlives any one device: the tailnet policy and DNS, the Cloudflare zone for `mippbipp.com`, and OpenTofu's migration target for pewter's OCI network/compute/budgets. Each provider has its own local state; devices only carry interface flags.
_Avoid_: server config, backend config, terraform config (too generic)

**Tailnet policy file**:
The single JSON policy that defines `tagOwners`, `autoApprovers`, `grants`, `ssh`, and `nodeAttrs` (including `tailscale.com/app-connectors` and `nextdns:<profile>` / `nextdns:no-device-info`). Surfaced in Terraform as `tailscale_acl`. Terraform is source of truth; console edits are overwritten.
_Avoid_: ACL file, rules file

**Cloudflare zone**:
The DNS zone for `mippbipp.com` that fronts `cache.mippbipp.com` (pewter attic). Owned by OpenTofu in `terraform/cloudflare/`; `cache` is `DNS-only` for `nginx` Let's Encrypt today, future subdomains may be proxied.
_Avoid_: domain config, DNS config

**External infra**:
The root-tenancy VCN/security lists/instance/budgets backing pewter. The OpenTofu stack is `terraform/oci/`; until its imports are applied, the existing resources remain manually provisioned. The NixOS device config lives in `hosts/pewter/` and is not managed by tofu.
_Avoid_: cloud config, oracle config, server infra
