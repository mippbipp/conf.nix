{
  inputs,
  config,
  terminal,
  ...
}:
{
  imports = [
    inputs.caelestia-shell.homeManagerModules.default
  ];
  programs.caelestia = {
    enable = true;
    systemd = {
      enable = true;
      target = "graphical-session.target";
      environment = [ ];
    };
    settings = {
      appearance = {
        font = {
          scale = 0.9;
          clock = config.stylix.fonts.monospace.name;
          workspaces = config.stylix.fonts.monospace.name;
          headline.family = config.stylix.fonts.sansSerif.name;
          title.family = config.stylix.fonts.sansSerif.name;
          body.family = config.stylix.fonts.sansSerif.name;
          label.family = config.stylix.fonts.sansSerif.name;
          mono.family = config.stylix.fonts.monospace.name;
        };
        anim.durations.scale = 0.2;
      };
      general = {
        showOverFullscreen = true;
        apps.terminal = [ terminal ];
        idle = {
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
      bar = {
        persistent = false;
        showOnHover = false;
        workspaces = {
          label = "●";
          occupiedLabel = "󰊠";
          activeLabel = "󰮯";
          showWindows = false;
        };
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
            id = "microphone";
            enabled = true;
          }
          {
            id = "kbLayout";
            enabled = false;
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
        entries = [
          {
            id = "logo";
            enabled = true;
          }
          {
            id = "workspaces";
            enabled = true;
          }
          {
            id = "spacer";
            enabled = true;
          }
          {
            id = "tray";
            enabled = true;
          }
          {
            id = "clock";
            enabled = true;
          }
          {
            id = "statusIcons";
            enabled = true;
          }
          {
            id = "power";
            enabled = true;
          }
        ];
      };
      dashboard = {
        showMedia = false;
      };
      launcher = {
        vimKeybinds = true;
      };
      border = {
        thickness = 0;
        rounding = 0;
        smoothing = 1;
      };
      services = {
        audioIncrement = 0.01;
        brightnessIncrement = 0.01;
      };
      session = {
        vimKeybinds = true;
        commands.logout = [
          "uwsm"
          "stop"
        ];
      };
      paths.sessionGif = "root:/assets/bongocat.gif";
    };
    cli = {
      enable = true;
      settings.theme.enableGtk = false;
    };
  };
}
