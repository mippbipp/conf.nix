{
  inputs,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    inputs.vicinae.homeManagerModules.default
    inputs.vicinae-dgpu.homeManagerModules.default
  ];
  programs.vicinae = {
    enable = true;
    extensions = [
      inputs.vicinae-dgpu.packages.${pkgs.stdenv.hostPlatform.system}.extension
    ];
    systemd = {
      enable = true;
      autoStart = true;
    };
    settings = {
      faviconService = "twenty";
      popToRootOnClose = true;
      rootSearch.searchFiles = false;
      window = {
        csd = false;
      };
      launcher_window = {
        opacity = lib.mkForce 0.7;
      };
    };
  };
}
