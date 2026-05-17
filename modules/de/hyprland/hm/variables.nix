{
  wayland.windowManager.hyprland.settings = {
    general = {
      gaps_in = 4;
      gaps_out = 4;
      border_size = 0;
      resize_on_border = true;
      layout = "dwindle";
    };

    input = {
      repeat_rate = 50;
      repeat_delay = 300;
      sensitivity = 0;
      numlock_by_default = true;
      follow_mouse = 1;
      float_switch_override_focus = 0;
      accel_profile = "flat";

      touchpad = {
        natural_scroll = true;
        disable_while_typing = true;
        scroll_factor = 0.8;
      };
    };
    cursor = {
      no_hardware_cursors = 1;
    };

    gesture = [ "3, swipe, workspace" ];

    misc = {
      disable_hyprland_logo = true;
      disable_splash_rendering = true;
      initial_workspace_tracking = 0;
      mouse_move_enables_dpms = true;
      key_press_enables_dpms = true;
      focus_on_activate = true;
    };

    xwayland = {
      force_zero_scaling = true;
    };

    dwindle = {
      preserve_split = true;
      special_scale_factor = 0.8;
    };

    master = {
      new_on_top = true;
      mfact = 0.5;
    };

    debug = {
      disable_logs = true;
    };

    animations = {
      enabled = false;
    };
    decoration = {
      rounding = 10;
      blur = {
        enabled = true;
        passes = 2;
      };
      shadow = {
        enabled = false;
      };
    };
  };
}
