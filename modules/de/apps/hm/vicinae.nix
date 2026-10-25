{
  config,
  inputs,
  lib,
  ...
}:
{
  imports = [
    inputs.vicinae.homeManagerModules.default
    inputs.vicinae-dgpu.homeManagerModules.default
  ];
  programs.vicinae = {
    enable = true;
    extensions = [ config.services.dgpu.extension ];
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
