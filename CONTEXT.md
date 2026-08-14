# Configuration Flake

Declarative NixOS/home-manager configuration for the host machines (gram, harpe, pewter, midd).

## Build

`nrs`: rebuilds and switches this machine from this flake — current host by default, `nrs <host>` for another. See `modules/hm/devenv/scripts/nrs.nix`.

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
