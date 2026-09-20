{
  pkgs,
  username,
  ...
}:
{
  services = {
    printing = {
      enable = true;
      browsed.enable = true;
    };
    ipp-usb.enable = true;
    avahi = {
      enable = true;
      nssmdns4 = true;
      openFirewall = true;
    };
  };

  hardware.sane = {
    enable = true;
    extraBackends = [ pkgs.sane-airscan ];
    disabledDefaultBackends = [ "escl" ];
  };

  users.users."${username}".extraGroups = [
    "scanner"
    "lp"
  ];
}
