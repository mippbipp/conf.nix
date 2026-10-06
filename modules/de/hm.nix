{ config, ... }: {
  imports = [
    ./apps/hm/vicinae.nix
    ./apps/hm/flameshot.nix
    ./apps/networkmanager/hm.nix
  ];

  home.file."Pictures/Wallpapers".source =
    config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/conf.nix/modules/de/wallpapers";
}
