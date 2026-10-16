{
  lib,
  pkgs,
  host,
  globals,
  ...
}:
{
  programs.opencode = lib.mkIf (!globals.hosts.${host}.isWorkPc) {
    enable = true;
    package = pkgs.opencode2;
  };

  home.packages = with pkgs; [
    kiro-cli
  ];
}
