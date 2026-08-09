_:
let
  inherit (import ./variables.nix) gitUsername;
in
{
  _module.args = { inherit gitUsername; };
  home.stateVersion = "26.05";

  imports = [
    ../../modules/hm/config.nix
    ../../modules/ssh/hm.nix
    ../../modules/ssh/sops.nix
    ../../modules/hm/devenv/default.nix
  ];
}
