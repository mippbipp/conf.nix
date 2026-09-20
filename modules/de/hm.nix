_: {
  imports = [
    ./apps/hm/vicinae.nix
    ./apps/hm/flameshot.nix
    ./apps/networkmanager/hm.nix
  ];

  home.file."Pictures/Wallpapers" = {
    source = ./wallpapers;
    recursive = true;
  };
}
