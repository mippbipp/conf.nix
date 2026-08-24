args: {
  home.stateVersion = "24.05";

  imports = [
    ../../modules/hm/config.nix
    ../../modules/ssh/hm.nix
    ../../modules/theme/hm.nix
    ../../modules/hm/devenv/default.nix
    ../../modules/hm/apps/zen/default.nix
  ];
}
