{ pkgs, ... }:
{
  stylix = {
    enable = true;
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
        package = pkgs.noto-fonts-cjk-serif;
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
      noto-fonts-cjk-sans
      font-awesome
      material-icons
    ];
  };
}
