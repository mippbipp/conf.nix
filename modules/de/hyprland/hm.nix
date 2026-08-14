{
  pkgs,
  lib,
  config,
  terminal,
  ...
}:
let
  hyprConfig = "${config.home.homeDirectory}/conf.nix/modules/de/hyprland";
  luaConfig = "${hyprConfig}/lua";
in
{
  services = {
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
        terminal = "${terminal}",
      }
    '';
  };

  imports = [
    ./env.nix
  ];
}
