{
  lib,
  config,
  globals,
  host,
  terminal,
  ...
}:
let
  outOfStore = globals.hosts.${host}.hasRepoCheckout;
  hyprConfig = "${config.home.homeDirectory}/conf.nix/modules/de/hyprland";
  luaConfig = "${hyprConfig}/lua";
  storeHyprland = ./hyprland.lua;
  storeLua = ./lua;
in
{
  imports = [
    ./quickshell/hm.nix
    ./env.nix
  ];

  services = {
    hyprpolkitagent.enable = true;
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
      if outOfStore then
        config.lib.file.mkOutOfStoreSymlink "${hyprConfig}/hyprland.lua"
      else
        storeHyprland
    );
    "hypr/lua".source = if outOfStore then config.lib.file.mkOutOfStoreSymlink luaConfig else storeLua;
    "hypr/env.lua".text = ''
      return {
        terminal = "${terminal}",
      }
    '';
  };
}
