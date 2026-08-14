{
  terminal,
  config,
  ...
}:
{
  programs.caelestia = {
    enable = true;
    systemd = {
      enable = true;
      target = "graphical-session.target";
      environment = [ ];
    };
    settings = {
      appearance.font = {
        scale = 0.9;
        clock = config.stylix.fonts.monospace.name;
        workspaces = config.stylix.fonts.monospace.name;
        headline.family = config.stylix.fonts.sansSerif.name;
        title.family = config.stylix.fonts.sansSerif.name;
        body.family = config.stylix.fonts.sansSerif.name;
        label.family = config.stylix.fonts.sansSerif.name;
        mono.family = config.stylix.fonts.monospace.name;
      };
      background = {
        enabled = true;
        wallpaperEnabled = true;
      };
      bar = {
        persistent = false;
        showOnHover = true;
        workspaces.shown = 5;
        statusIcons = [
          {
            id = "lockStatus";
            enabled = true;
          }
          {
            id = "audio";
            enabled = true;
          }
          {
            id = "network";
            enabled = true;
          }
          {
            id = "bluetooth";
            enabled = true;
          }
          {
            id = "battery";
            enabled = true;
          }
        ];
      };
      general = {
        apps.terminal = [ terminal ];
        idle = {
          lockBeforeSleep = true;
          timeouts = [
            {
              timeout = 300;
              idleAction = "lock";
            }
            {
              timeout = 330;
              idleAction = "dpms off";
              returnAction = "dpms on";
            }
            {
              timeout = 1200;
              idleAction = [ "suspend" ];
            }
          ];
        };
      };
      session = {
        vimKeybinds = true;
        commands.logout = [
          "uwsm"
          "stop"
        ];
      };
      services.audioIncrement = 0.05;
    };
    cli = {
      enable = true;
      settings.theme.enableGtk = false;
    };
  };
}
