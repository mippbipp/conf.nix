# Configuration Flake

Declarative NixOS/home-manager configuration for the host machines (gram, harpe, pewter, midd).

## Build

`nrs`: rebuilds and switches this machine from this flake — current host by default, `nrs <host>` for another. See `modules/hm/devenv/scripts/nrs.nix`.

## Terminal multiplexing

`ws`: The herdr project picker that jumps from a base terminal into a workspace by fuzzy-searching repo directories. Successor of tmux-sessionizer.
