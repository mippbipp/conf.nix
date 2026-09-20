{ pkgs, ... }:
{
  imports = [
    ./quickshell/lock.nix
  ];

  environment.systemPackages = with pkgs; [
    wev

    normcap
    grim # wayland support for normcap

    wl-clipboard
    hyprpicker
    hyprland-qtutils
    wl-mirror
  ];

  programs = {
    hyprland = {
      enable = true;
      withUWSM = true;
    };
    nix-ld = {
      libraries = with pkgs; [
        # for oklch-color-picker.nvim
        wayland
        libxkbcommon
        libGL
        libglvnd
      ];
    };
  };

  xdg.portal = {
    enable = true;
    extraPortals = [
      # for file picker (XDPH doesn't have it)
      pkgs.xdg-desktop-portal-gtk
    ];
  };

}
