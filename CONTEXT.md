# conf.nix

A NixOS flake-based system configuration managing multiple hosts with Home Manager integration.

## Language

**Host**:
A physical or virtual machine configured by this repo. Each host has its own directory under `hosts/` containing `config.nix`, `home.nix`, `variables.nix`, and `users.nix`.
_Avoid_: machine, node, instance

**Module**:
A reusable NixOS or Home Manager configuration unit. Modules live under `modules/` and are organized by concern (system, hm, de, theme, ssh).
_Avoid_: component, config, package

**Devenv Module**:
The Home Manager modules under `modules/hm/devenv/` that install development tools (rust, node, python, go, opencode) and configure shell environment (zsh, tmux, starship, direnv, zoxide).
_Avoid_: dev tools, shell config, development environment

**Dev Shell**:
Standalone Nix flake-based development environments under `shells/` for specific language stacks (node/pnpm, python, rust/bevy, rust/tauri, cuda). Used by other projects, not by this config.
_Avoid_: devenv, shell, environment

**nrs**:
The rebuild script installed by the devenv module. Handles local rebuilds (`nrs`) and remote rebuilds (`nrs pewter`). Automatically adds `--build-host` for ARM targets.
_Avoid_: rebuild, switch, apply

**SOPS**:
Secrets management via `sops-nix`. Currently used only to hide the git email address in the git config. Path pattern: `secrets/[^/]+\.(yaml|json|env|ini)$`.
_Avoid_: secrets, encryption, age

**Lanzaboote**:
Secure boot implementation for the `gram` host. Replaces systemd-boot with a measured boot chain.
_Avoid_: secure boot, trusted boot

**Desktop Environment (DE)**:
The graphical environment on `gram`, built on Hyprland (Wayland compositor) with greetd (login manager), waybar (status bar), swaync (notification center), and wlogout (logout menu).
_Avoid_: GUI, window manager, desktop

**Stylix**:
NixOS module for system-wide theming. Sets global colors and fonts based on a base16 theme. Per-app overrides are possible but not currently used.
_Avoid_: theme, colors, appearance

**nixos-anywhere**:
Tool for deploying NixOS to remote machines, used for the `pewter` ARM cloud VM. Handles disk encryption setup and initial provisioning.
_Avoid_: deploy, provision, remote install

## Hosts

**gram**:
Main desktop PC. NixOS with Lanzaboote secure boot, nvidia+intel GPU drivers, Hyprland DE, gaming, printing, scanning.
_Avoid_: main, desktop, primary

**harpe**:
Windows Subsystem for Linux (WSL) instance. NixOS-WSL, x86_64-linux. Minimal config without desktop environment.
_Avoid_: wsl, windows

**pewter**:
ARM cloud VM on Oracle Cloud (aarch64-linux). Disk encryption via LUKS, nixos-anywhere deployment, Tailscale networking, Syncthing.
_Avoid_: cloud, server, arm

## Conventions

**variables.nix**:
Per-host configuration file containing wallpaper path, git username, and terminal choice. Located at `hosts/{hostname}/variables.nix`.
_Avoid_: config, settings, host config

**mkHostConfig**:
Function in `flake.nix` that creates a NixOS system configuration for a host. Takes `host`, `username`, optional `nixosModules`, and optional `homeManagerModules`.
_Avoid_: host builder, config generator

**?submodules=1**:
Required flake reference suffix to initialize git submodules (specifically the nvim config). Example: `~/conf.nix?submodules=1#gram`.
_Avoid_: submodule flag, git submodules
