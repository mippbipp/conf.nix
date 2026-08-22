_:
{
  home.stateVersion = "26.05";

  imports = [
    ../../modules/hm/config.nix
    ../../modules/ssh/hm.nix
    ../../modules/hm/devenv/default.nix
  ];
}
