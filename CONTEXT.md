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

## Build

`nrs`: rebuilds and switches this machine from this flake — current host by default, `nrs <host>` for another. See `modules/hm/devenv/scripts/nrs.nix`.

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
The persistent Nix binary cache hosted on pewter. GitHub-hosted Build gate runners use it to avoid rebuilding gram's large closure on every run; the cache has public reads and authenticated CI writes.
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

## Tailnet

**Control plane**:
Tailnet-wide settings that live in the Tailscale coordination server, not on any one device: the tailnet policy file (ACLs), DNS globals, and device approvals. Owned by OpenTofu in `terraform/tailscale/`; devices only carry interface flags.
_Avoid_: server config, backend config

**Tailnet policy file**:
The single JSON policy that defines `tagOwners`, `autoApprovers`, `grants`, `ssh`, and `nodeAttrs` (including `tailscale.com/app-connectors`). Surfaced in Terraform as `tailscale_acl`. Terraform is source of truth; console edits are overwritten.
_Avoid_: ACL file, rules file
