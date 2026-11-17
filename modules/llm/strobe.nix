{ pkgs, ... }:
let
  # strobe (https://github.com/anomalyco/strobe) launches its own fresh-profile
  # Chromium. Chrome policy (modules/de/apps/system/chromium.nix) force-installs
  # extensions into every profile, and their work would land in the measurements.
  browser = pkgs.writeShellScript "strobe-chromium" ''
    exec ${pkgs.chromium}/bin/chromium --disable-extensions "$@"
  '';
in
{
  home = {
    sessionVariables.STROBE_BROWSER = "${browser}";
  };
}
