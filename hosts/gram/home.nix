_: {
  _module.args.terminal = "ghostty";
  home.stateVersion = "23.11";
  xdg.mimeApps.enable = true;

  imports = [
    ../../modules/hm/config.nix
    ../../modules/theme/hm.nix
    ../../modules/hm/devenv/default.nix
    ../../modules/de/hm.nix
    ../../modules/de/thunar/hm.nix
    ../../modules/de/computer-use-linux/hm.nix
    ../../modules/hm/apps/ghostty.nix
    ../../modules/hm/apps/winapps/default.nix
    ../../modules/hm/apps/zen/default.nix
    ../../modules/hm/apps/mpv.nix
    ../../modules/hm/apps/discord.nix
    ../../modules/ssh/hm.nix
  ];
}
