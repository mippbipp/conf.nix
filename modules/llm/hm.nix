# Harness HM bit: base opencode wiring for every host.
{ pkgs, ... }:
{
  programs.opencode = {
    enable = true;
    package = pkgs.opencode2;
  };
}
