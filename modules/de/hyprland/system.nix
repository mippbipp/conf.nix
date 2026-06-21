{ pkgs, ... }:
{
  imports = [
    ./lock/system.nix
  ];

  environment.systemPackages = with pkgs; [
    libnotify
    brightnessctl
    ddcutil
    i2c-tools
    pavucontrol
    pulseaudio
    alsa-utils
    swaynotificationcenter
    wev

    normcap
    grim # wayland support for normcap

    wl-clipboard
    ifuse
    libimobiledevice
    hyprpicker
    hyprshot
    hyprland-qtutils
    wl-mirror
    wayscriber
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
      pkgs.xdg-desktop-portal-gtk
    ];
  };

  services = {
    usbmuxd = {
      enable = true;
      package = pkgs.usbmuxd2;
    };
  };

  # ddcutil
  hardware.i2c.enable = true;

  # Bluetooth Support
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = false;
  };
  services.blueman.enable = true;
}
