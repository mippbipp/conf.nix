args:
{
  _module.args.terminal = "ghostty";
  home.stateVersion = "24.05";

  imports = [
    ../../modules/hm/config.nix
    ../../modules/ssh/hm.nix
    ../../modules/theme/hm.nix
    ../../modules/hm/devenv/default.nix
    (import ../../modules/hm/apps/ghostty.nix (
      args
      // {
        background-opacity = 1;
      }
    ))
    ../../modules/hm/apps/zen/default.nix
  ];
}
