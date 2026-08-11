_: {
  xdg = {
    userDirs = {
      enable = true;
      createDirectories = true;
      setSessionVariables = false;
    };
  };

  imports = [
    ./vicinae.nix
    ./hyprland/hm.nix
    ./waybar.nix
    ./swaync.nix
    ./wlogout/config.nix
    ../hm/apps/flameshot.nix
  ];

  home.file."Pictures/wallpapers" = {
    source = ./wallpapers;
    recursive = true;
  };
}
