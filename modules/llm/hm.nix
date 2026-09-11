# Harness HM bit: base opencode wiring for every host.
#
# Owns programs.opencode enable + package only. Desktop-specific MCP
# entries live with their owner (modules/de/computer-use-linux/hm.nix
# contributes its server by plain assignment; it is only imported where
# a desktop exists, so no detection and no Role flag). Imported via
# modules/hm/devenv/default.nix, hence present on all five NixOS homes.
{ pkgs, ... }:
{
  programs.opencode = {
    enable = true;
    package = pkgs.opencode2;
  };
}
