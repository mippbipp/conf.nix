{
  pkgs,
  ...
}:
{
  stylix = {
    targets = {
      btop = {
        enable = true;
        opacity.enable = true;
      };
      font-packages = {
        enable = true;
        fonts.enable = true;
      };
      fontconfig = {
        enable = true;
        fonts.enable = true;
      };
      ghostty = {
        enable = true;
        fonts.enable = true;
        opacity.enable = true;
      };
      gnome = {
        enable = true;
        fonts.enable = true;
        polarity.enable = true;
      };
      gtk = {
        enable = true;
        cursor.enable = true;
        fonts.enable = true;
      };
      gtksourceview.enable = true;
      lazygit.enable = true;
      mpv = {
        enable = true;
        fonts.enable = true;
      };
      opencode.enable = true;
      vicinae = {
        enable = true;
        fonts.enable = true;
        opacity.enable = true;
        polarity.enable = true;
      };
    };
    icons = {
      enable = true;
      package = pkgs.adwaita-icon-theme;
      dark = "Adwaita";
    };
  };
  home.pointerCursor.enable = true;
}
