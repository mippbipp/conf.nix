# Configuration flake

Declarative NixOS and home-manager configuration for the fleet in `hosts/`.

## Hosts

- **gram**: laptop (Secure Boot via lanzaboote).
- **harpe**: WSL guest on the personal laptop.
- **warpe**: WSL guest on the work laptop; carries the company CA trust.
- **pewter**: always-on Oracle ARM server; tailnet exit node and remote workspace host.
- **midd**: Windows host; only `hosts/midd/setup.ps1`, not a NixOS config.

## Host isolation

**Personal host**:
A fleet member that may hold the shared age identity and personal secrets. The `isPersonalHost` Role flag gates the personal secret list; installing the shared age key is a deploy-time step, not part of the flag.
_Avoid_: personal machine (ambiguous)

## Work identity

**Work identity**:
The work git name, email, and SSH key applied on dual-use hosts for checkouts under `~/work/` via a conditional git include. Personal identity stays the global default everywhere.
_Avoid_: work account

**Work secret file**:
The work-only sops file decryptable on hosts with the work age identity.
_Avoid_: work secrets

**Conditional identity**:
Directory-gated git identity selection (`includeIf gitdir:`) instead of per-repo configuration.
_Avoid_: per-repo config

## Gram GPU policy

**Offload launch**:
Starting an app with `__NV_PRIME_RENDER_OFFLOAD` so it renders on the dGPU while gram stays on the iGPU. Individual launches only; see ADR 0003 for the gamescope exception.
_Avoid_: gpu switching

## Isolation tiers (gram)

**Kept VM**:
A libvirtd VM with persistent state and a manager entry; survives reboots and supports snapshots. Sketchy keepers attach to an isolated network with no forwarding.
_Avoid_: persistent vm

**Throwaway VM**:
A quickemu VM whose lifetime is its directory; removing the directory removes the VM.
_Avoid_: ephemeral vm

## Build

**nrs**:
The rebuild command for this flake. It switches the current host by default and `nrs <host>` for another, substituting from Attic; `nrs --push` publishes. It builds from the `~/conf.nix` checkout; repo-relative Home Manager files (e.g. nvim, hyprland) symlink out-of-store into it. See ADR 0020.
_Avoid_: rebuild, deploy

## Globals

**Globals**:
The single source for facts that outlive any one module: identity, DNS profile, cache endpoints, and a per-machine record. Records are typed Role flags declared in `modules/fleet/registry.nix`: NixOS modules read `config.fleet.hosts`, Home Manager receives the merged records as the `globals` argument; never imported directly.
_Avoid_: variables, constants

**Role flag**:
A boolean capability on a Globals record that shared modules branch on instead of comparing host names. Setting one is enough to get its implementation; `modules/fleet/` selects it, so host files carry no role imports. See ADR 0020.
_Avoid_: feature flag

## Flake update pipeline

**Attic cache**:
The persistent Nix cache on pewter at `cache.mippbipp.com/fleet`. Hosts substitute from it; the Build gate and `nrs --push` publish to it.
_Avoid_: build cache (ambiguous)

**Build gate**:
The required CI check that builds every host's toplevel before main can merge. It enforces "main is always buildable".
_Avoid_: CI (generic)

**Flake fixer**:
The opencode agent pewter's Updater calls when the Build gate is red on the update PR. It fixes our configuration or asks for inputs to be held back at main's revision; the Updater commits, pushes and reverts lock entries itself. See ADR 0009.
_Avoid_: bot, auto-fixer

**Held-back input**:
A flake input whose lock entry the Updater reverted to main's revision for one update PR, at the Flake fixer's request. It has an open issue and is retried by the next week's update.
_Avoid_: pinned input

## Theming

**Stylix**:
The Nix theming framework that sets palette, fonts, and cursor and propagates via Home Manager. Targets auto-enable; those with custom theming are disabled.
_Avoid_: theme manager (generic)

**Manual sync**:
Keeping the nvim colorscheme equal to the Stylix `base16Scheme` by hand for nvim portability. See ADR 0016.
_Avoid_: auto sync

## AI

**Remote workspace**:
A t3 server on a different machine than the client. Projects and sessions live on the server; the client only drives it.
_Avoid_: remote agent

**Pairing**:
The one-time `t3 pair` token exchange that enrolls a client with the pewter remote workspace.
_Avoid_: login, auth

**Harness**:
The versioned LLM CLIs shared across hosts and their shared configuration.
_Avoid_: llm setup

## DNS layering

**Host-local resolver**:
The host's `systemd-resolved` that forwards `~.` to NextDNS over DoT. It survives `tailscaled` being down and is the fallback when the tailnet global is absent.
_Avoid_: local dns, system dns

**Tailnet global nameserver**:
The tailnet-wide nameserver pushed to clients that accept DNS. For NextDNS it maps to the profile via `nodeAttrs` over DoH.
_Avoid_: global dns

**MagicDNS**:
The `*.ts.net` route via `100.100.100.100`; automatic on most hosts, split-wired on `warpe`.
_Avoid_: quad100

**Override local DNS**:
The tailnet flag required for iOS MagicDNS, disabled on `warpe`.
_Avoid_: override dns

## Tailnet serving

**Tailnet expose**:
A loopback-only listener made reachable over the tailnet; tailscaled terminates tailnet TLS and proxies to it (Tailscale Serve).
_Avoid_: serve, mapping

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
