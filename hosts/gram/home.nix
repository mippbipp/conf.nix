_: {
  _module.args.terminal = "ghostty";
  home.stateVersion = "23.11";
  xdg.mimeApps.enable = true;

  imports = [
    ../../modules/hm/config.nix
    ../../modules/theme/hm.nix
    ../../modules/hm/devenv
    ../../modules/de/hm.nix
    ../../modules/de/hyprland/hm.nix
    ../../modules/de/apps/thunar/hm.nix
    ../../modules/de/computer-use-linux/hm.nix
    ../../modules/de/apps/hm/ghostty.nix
    ../../modules/de/apps/hm/winapps
    ../../modules/de/apps/hm/zen
    ../../modules/de/apps/hm/mpv.nix
    ../../modules/de/apps/hm/discord.nix
    ../../modules/ssh/hm.nix
  ];
}
