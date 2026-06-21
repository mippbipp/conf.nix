{
  pkgs,
  host,
  ...
}@args:
let
  inherit (import ./variables.nix)
    gitUsername
    terminal
    ;
  INTERNAL = "eDP-1";
  EXTERNAL = "HDMI-A-4";
in
{
  home.stateVersion = "23.11";
  xdg.mimeApps.enable = true;

  imports = [
    ../../modules/hm/config.nix
    (import ../../modules/theme/hm.nix { inherit pkgs; })
    (import ../../modules/hm/devenv/default.nix (args // { inherit gitUsername; }))
    (import ../../modules/de/hm.nix (
      args
      // {
        inherit
          terminal
          INTERNAL
          EXTERNAL
          ;
      }
    ))
    ../../modules/de/thunar/hm.nix
    ../../modules/hm/apps/ghostty.nix
    ../../modules/hm/apps/winapps/default.nix
    ../../modules/hm/apps/zen/default.nix
    ../../modules/hm/apps/gimp.nix
    ../../modules/hm/apps/mpv.nix
    (import ../../modules/ssh/hm.nix { inherit host; })
    ../../modules/ssh/sops.nix
  ];
}
