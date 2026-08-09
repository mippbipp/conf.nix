{ lib, ... }:
{
  services = {
    hypridle = {
      enable = true;
      settings = {
        general = {
          lock_cmd = "pidof hyprlock || hyprlock";
          before_sleep_cmd = "loginctl lock-session"; # lock before suspend
          after_sleep_cmd = "hyprctl dispatch 'hl.dsp.dpms({ action = \"on\" })' && hyprctl reload"; # monitors on and reloaded to prevent hyprlock freezing
          inhibit_sleep = 3; # wait until screen is locked
        };
        listener = [
          {
            timeout = 300;
            on-timeout = "loginctl lock-session";
          }
          {
            timeout = 330;
            on-timeout = "hyprctl dispatch 'hl.dsp.dpms({ action = \"off\" })'";
            on-resume = "hyprctl dispatch 'hl.dsp.dpms({ action = \"on\" })'";
          }
          {
            timeout = 1200;
            on-timeout = "systemctl suspend";
          }
        ];
      };
    };
  };
  programs = {
    hyprlock = {
      enable = true;
      settings = lib.mkForce {
        general = {
          grace = 0;
          hide_cursor = true;
          ignore_empty_input = true;
        };
        animations.enabled = false;
        background = [
          {
            color = "rgba(0, 0, 0, 1.0)";
          }
        ];
        input-field = [
          {
            size = "200, 50";
            position = "0, -80";
            monitor = "";
            dots_center = true;
            fade_on_empty = false;
            font_color = "rgb(CFE6F4)";
            inner_color = "rgb(657DC2)";
            outer_color = "rgb(0D0E15)";
            outline_thickness = 5;
            placeholder_text = "...";
            shadow_passes = 2;
          }
        ];
      };
    };
  };
}
