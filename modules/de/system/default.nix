{
  pkgs,
  ...
}:
{
  imports = [
    ./libinput.nix
    ./audio.nix
    ./mouse.nix
    ./ddcutil.nix
    ./ios.nix
    ./ly.nix
    ../apps/networkmanager/system.nix
  ];

  environment.systemPackages = with pkgs; [
    libnotify
    pavucontrol
    pulseaudio
    alsa-utils
  ];

  # Bluetooth Support
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = false;
  };
  services.blueman.enable = true;

}
