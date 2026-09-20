{
  inputs,
  lib,
  ...
}:
{
  imports = [
    inputs.vicinae.homeManagerModules.default
  ];
  programs.vicinae = {
    enable = true;
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
