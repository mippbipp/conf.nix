{
  pkgs,
}:
{
  stylix = {
    targets = {
      waybar.enable = false;
      hyprland.enable = false;
      tmux.enable = false;
      starship.enable = false;
      zen-browser.enable = false;

      # https://github.com/nix-community/home-manager/issues/5175#issuecomment-2227203880
      neovim.enable = false;
      neovide.enable = false;
    };
    icons = {
      enable = true;
      package = pkgs.papirus-icon-theme;
      dark = "Papirus-Dark";
    };
  };
}
