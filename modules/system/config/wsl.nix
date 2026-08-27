# NixOS-WSL specific system config, shared by the WSL hosts.
_: {
  wsl.useWindowsDriver = true;

  # Stop WSL from overwriting /etc/resolv.conf on every boot
  # systemd-resolved provides better fidelity with custom DNS
  wsl.wslConf.network.generateResolvConf = false;
  networking.resolvconf.enable = false;
  services.resolved = {
    enable = true;
    settings.Resolve.FallbackDNS = [ "10.255.255.254" ]; # cat /etc/resolv.conf, default for WSL
  };
}
