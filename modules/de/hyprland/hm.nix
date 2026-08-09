{
  pkgs,
  lib,
  config,
  terminal,
  ...
}:
let
  env = {
    wlogout = "${pkgs.callPackage ../wlogout/launcher.nix { }}/bin/wlogout-launcher";
    brightness = "${pkgs.callPackage ../scripts/brightness.nix { }}/bin/brightness-control";
  };
  hyprConfig = "${config.home.homeDirectory}/conf.nix/modules/de/hyprland";
  luaConfig = "${hyprConfig}/lua";
in
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
    configType = "lua";

    # https://wiki.hypr.land/Nix/Hyprland-on-Home-Manager/#using-the-home-manager-module-with-nixos
    package = null;
    portalPackage = null;
  };

  xdg.configFile = {
    "hypr/hyprland.conf".enable = lib.mkForce false;
    "hypr/hyprland.lua".source = lib.mkForce (
      config.lib.file.mkOutOfStoreSymlink "${hyprConfig}/hyprland.lua"
    );
    "hypr/lua".source = config.lib.file.mkOutOfStoreSymlink luaConfig;
    "hypr/env.lua".text = ''
      return {
        wlogout = "${env.wlogout}",
        brightness = "${env.brightness}",
        terminal = "${terminal}",
      }
    '';
  };

  imports = [
    ./lock/hm.nix
    ./env.nix
  ];
}
