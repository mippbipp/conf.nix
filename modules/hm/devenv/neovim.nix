{
  pkgs,
  config,
  ...
}:
{
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
  xdg.configFile."nvim".source =
    config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/conf.nix/modules/hm/devenv/nvim";
}
