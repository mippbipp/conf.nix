_: {
  imports = [
    ./vicinae.nix
    ./hyprland/hm.nix
    ./quickshell.nix
    ../hm/apps/flameshot.nix
  ];

  home.file."Pictures/Wallpapers" = {
    source = ./wallpapers;
    recursive = true;
  };
}
