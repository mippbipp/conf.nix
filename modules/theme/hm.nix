{
  pkgs,
  ...
}:
{
  stylix = {
    targets = {
      hyprland.enable = false;
      starship.enable = false;
      zen-browser.enable = false;
      neovim.enable = false;
    };
    icons = {
      enable = true;
      package = pkgs.papirus-icon-theme;
      dark = "Papirus-Dark";
    };
  };
  home.pointerCursor.enable = true;
}
