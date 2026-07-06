# AGENTS.md

## Repository Overview

NixOS flake-based system configuration with Home Manager. Three hosts managed from a single repo. Also serves as a reference for others to fork and adapt.

Domain terminology is defined in [`CONTEXT.md`](./CONTEXT.md).

## Hosts

| Host | Type | Notes |
|------|------|-------|
| `gram` | Main PC | NixOS, Lanzaboote secure boot, nvidia+intel, Hyprland DE |
| `harpe` | WSL | NixOS-WSL, x86_64-linux, no desktop environment |
| `pewter` | Cloud VM | ARM (aarch64-linux), Oracle, LUKS disk encryption, nixos-anywhere |

## Key Commands

```sh
# Rebuild current host (runs from repo root)
nrs

# Rebuild specific remote host
nrs pewter

# Manual nixos-rebuild
sudo nixos-rebuild switch --flake ~/conf.nix?submodules=1#${HOST}

# Inspect config in REPL
nix repl ~/conf.nix#nixosConfigurations.{hostname}.config

# Deploy pewter (first time only)
nix run github:nix-community/nixos-anywhere -- \
  --flake .#pewter \
  --disk-encryption-keys /tmp/secret.key /tmp/pewter-luks.key \
  --extra-files /tmp/pewter-extra-files root@<PUBLIC_IP>

# Unlock pewter after reboot
ssh pewter-luks
systemd-tty-ask-password-agent
```

## Repository Structure

```
hosts/{hostname}/    # Per-host: config.nix, home.nix, variables.nix, users.nix
modules/
  system/            # NixOS modules (hardware, config, apps)
  hm/                # Home Manager modules (devenv, apps)
  de/                # Desktop environment (hyprland, greetd, waybar, etc.)
  theme/             # Stylix theme config
  ssh/               # SSH + sops integration
shells/              # Standalone dev shells for projects (node, python, rust, cuda)
```

## Module Layering

- **system/**: Host-wide NixOS configuration (hardware drivers, system services, networking)
- **hm/**: User-specific Home Manager configuration (dev tools, apps, shell)
- **de/**: Desktop environment (Hyprland, greetd, waybar) — gram only
- **theme/**: Stylix-based theming (global with per-app override capability)
- **ssh/**: SSH access and SOPS secrets integration

## Conventions

- Flake requires `?submodules=1` for nvim git submodule (standalone repo: `github:mippbipp/init.lua`)
- SOPS for secrets: age key (`admin_bob`), paths matching `secrets/[^/]+\.(yaml|json|env|ini)$`
- Hosts defined in `flake.nix` `nixosConfigurations` via `mkHostConfig`
- Hardware drivers toggle via `drivers.*.enable` options in host config
- `variables.nix` per host: wallpaper path, git username, terminal
- Dev tools installed via `modules/hm/devenv/default.nix` (shared across all hosts)
- `shells/` are standalone dev shells for other projects, not used by this config

## Gotchas

- `nrs` script handles remote rebuilds; pewter needs `--build-host` for ARM builds
- `pewter` LUKS unlock: `ssh pewter-luks` then `systemd-tty-ask-password-agent`
- WSL (`harpe`): set as default distro with `wsl -s NixOS`
- Submodule init: `git clone --recurse-submodules`
- No CI/CD or pre-deploy testing — changes apply directly
- SOPS currently only hides git email in config; may expand in future
