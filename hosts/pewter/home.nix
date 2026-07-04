args:
let
  inherit (import ./variables.nix) gitUsername;
in
{
  home.stateVersion = "26.05";

  # Import your baseline Home Manager modules, excluding GUI elements
  imports = [
    ../../modules/hm/config.nix
    ../../modules/ssh/hm.nix
    ../../modules/ssh/sops.nix
    (import ../../modules/hm/devenv/default.nix (args // { inherit gitUsername; }))
  ];
}
