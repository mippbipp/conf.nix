{ pkgs, ... }: {
  # iOS usb support
  environment.systemPackages = with pkgs; [
    ifuse
    libimobiledevice
  ];
  services.usbmuxd = {
    enable = true;
    package = pkgs.usbmuxd2;
  };
}
