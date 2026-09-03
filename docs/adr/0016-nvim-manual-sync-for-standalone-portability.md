# Neovim stays out-of-store and manually synced to Stylix

`modules/hm/devenv/nvim` is a git submodule symlinked out-of-store from `modules/hm/devenv/neovim.nix`. It must bootstrap with `lazy.nvim` on any distro without Nix. Stylix owns the desktop palette in `modules/theme/system.nix` and must not own `nvim`.

## Decision

Manual sync. The `nvim` colorscheme in `modules/hm/devenv/nvim/lua/plugins/colorscheme.lua` and the `LazyVim` colorscheme in `modules/hm/devenv/nvim/lua/config/lazy.lua` are kept equal to the Stylix `base16Scheme` by hand.

This keeps the submodule self-contained. No Nix-generated colors and no `config.lib.stylix.colors` import.

* `stylix.targets.neovim.enable = false` in `modules/theme/hm.nix` so Stylix does not inject a plugin via `programs.neovim`. That injection conflicts with the whole-dir symlink and would tie startup to Home Manager.
* `LazyVim` must point at the same scheme as the plugin. Its default is `tokyonight`, so the override is required once that plugin is disabled.
* `lualine` must use `theme = "tinted"` in `modules/hm/devenv/nvim/lua/plugins/lualine.lua`. The `base16` lualine theme requires `base16-nvim`, which is not installed with `tinted-nvim`.

## Considered options

* Stylix auto via `programs.neovim.plugins`. Rejected. It needs a Nix-generated `init.lua` and breaks the out-of-store symlink. It also makes `nvim` unbootable without Home Manager.
* Nix-templated `colorscheme.lua` via `xdg.configFile.*.text`. Rejected for the same symlink conflict. It would also pull a Nix dependency back into the submodule.

## Consequences

* Changing the Stylix scheme needs a second edit in `nvim`. Accepted. Drift is silent and falls back to `habamax` after a failed load, so theme changes must check both places.
* The disabled `tokyonight` and `catppuccin` entries remain in `lazy-lock.json`. Run `:Lazy clean` after switching plugins.

Status: accepted
