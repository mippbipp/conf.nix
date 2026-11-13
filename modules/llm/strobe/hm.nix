# strobe CLI for benching web apps, on every host. No `strobe up`: its daemon,
# MCP entry and skill install would write into opencode's config and the
# user's systemd units behind Nix. Fetch its trace engine once by hand:
#   strobe up --skip self,skill,daemon,mcp,deep
{ pkgs, ... }:
let
  # strobe launches its own fresh-profile Chromium. Chrome policy
  # (modules/de/apps/system/chromium.nix) force-installs extensions into every
  # profile, and their work would land in the measurements.
  browser = pkgs.writeShellScript "strobe-chromium" ''
    exec ${pkgs.chromium}/bin/chromium --disable-extensions "$@"
  '';
in
{
  home = {
    packages = [ pkgs.strobe ];
    sessionVariables.STROBE_BROWSER = "${browser}";
  };
}
