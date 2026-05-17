{
  pkgs,
  INTERNAL,
  EXTERNAL,
  terminal,
  ...
}:
{
  services = {
    hyprpaper = {
      enable = true; # config in stylix
      settings = {
        splash = false;
      };
    };
    hyprpolkitagent.enable = true;
    network-manager-applet.enable = true;
  };
  wayland.windowManager.hyprland = {
    enable = true;
    xwayland.enable = true;
    systemd.enable = false; # using uwsm instead
    configType = "hyprlang";

    # https://wiki.hypr.land/Nix/Hyprland-on-Home-Manager/#using-the-home-manager-module-with-nixos
    package = null;
    portalPackage = null;

    settings = {
      "$mainMod" = "SUPER";
      "$EXTERNAL" = EXTERNAL;
    };
  };

  imports = [
    ../lock/hm.nix
    ./env.nix

    # hyprland config imports
    (import ./startup.nix { inherit pkgs; })
    ./variables.nix
    (import ./keybinds.nix {
      inherit pkgs terminal;
    })
    (import ./laptop.nix {
      inherit pkgs INTERNAL;
    })
    ./window-rules.nix
  ];
}
