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

  wayland.windowManager.hyprland.settings = {
    bind = [
      "$mainMod, Space, exec, vicinae vicinae://toggle"
      "$mainMod, V, exec, vicinae vicinae://launch/clipboard/history?toggle=true"
    ];
    layerrule = [
      "blur on, ignore_alpha 0, match:namespace vicinae"
    ];
  };
}
