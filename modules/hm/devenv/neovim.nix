{
  pkgs,
  config,
  lib,
  host,
  globals,
  ...
}:
let
  outOfStore = globals.hosts.${host}.hasRepoCheckout;
in
{
  assertions = lib.optional (!outOfStore) {
    assertion = builtins.pathExists ./nvim/init.lua;
    message = "nvim submodule content is missing from the flake source: run git submodule update --init and evaluate with ?submodules=1";
  };

  home = {
    packages = with pkgs; [
      clang # cc for nvim-treesitter
      tree-sitter

      lua51Packages.lua
      lua51Packages.luarocks

      statix
      nixfmt
      oxfmt
    ];

    sessionVariables = {
      EDITOR = "nvim";
      MANPAGER = "nvim +Man!";
    };
  };

  programs = {
    neovim = {
      enable = true;
      defaultEditor = true;
      viAlias = true;
      vimAlias = true;
      vimdiffAlias = true;
      extraPackages = with pkgs; [
        lua-language-server
        python312Packages.pylatexenc # markdown preview
        lua51Packages.jsregexp # luasnip
        nil
        qt6.qtdeclarative # qmlls
        clang-tools # clangd (mason has no aarch64 build; see lsp.lua)

        # snacks.image
        imagemagick
        ghostscript # gs
        tectonic
        mermaid-cli # mmdc
      ];
      withRuby = false;
      withPython3 = false;
    };
  };

  # Prevent home-manager's neovim module from creating init.lua to symlink the whole directory.
  xdg.configFile."nvim/init.lua".enable = pkgs.lib.mkForce false;

  # Checkout hosts symlink out-of-store for live-edit without rebuilds.
  # Checkout-free hosts ship the same files from the store, always in
  # sync with the deployed system; plugin updates ride along with nrs.
  xdg.configFile."nvim".source =
    if outOfStore then
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/conf.nix/modules/hm/devenv/nvim"
    else
      ./nvim;
}
