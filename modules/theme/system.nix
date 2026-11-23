{ pkgs, ... }:
{
  stylix = {
    enable = true;
    # Targets are opt-in so an upstream target for an app we don't use can't
    # break evaluation (wayprompt in #245).
    autoEnable = false;
    overlays.enable = true;
    targets = {
      console.enable = true;
      font-packages = {
        enable = true;
        fonts.enable = true;
      };
      fontconfig = {
        enable = true;
        fonts.enable = true;
      };
      gtksourceview.enable = true;
      nixos-icons.enable = true;
    };
    base16Scheme = "${pkgs.base16-schemes}/share/themes/tokyo-night-dark.yaml";
    polarity = "dark";
    cursor = {
      name = "Bibata-Original-Classic";
      package = pkgs.bibata-cursors;
      size = 16;
    };
    fonts = {
      monospace = {
        package = pkgs.nerd-fonts.jetbrains-mono;
        name = "JetBrainsMono Nerd Font";
      };
      sansSerif = {
        package = pkgs.montserrat;
        name = "Montserrat";
      };
      serif = {
        package = pkgs.noto-fonts;
        name = "Noto Serif";
      };
      sizes = {
        applications = 12;
        desktop = 12;
        popups = 12;
      };
    };
  };

  fonts = {
    packages = with pkgs; [
      noto-fonts-color-emoji
    ];
  };
}
