# https://wiki.nixos.org/wiki/Tailscale
{
  config,
  pkgs,
  lib,
  host,
  username,
  ...
}:
{
  services.tailscale = {
    enable = true;
    disableUpstreamLogging = true; # disables debug logging
    useRoutingFeatures = "client";
  }
  // lib.optionalAttrs (host == "pewter") {
    useRoutingFeatures = "both";
    authKeyFile = "/var/lib/tailscale/authkey";
    extraUpFlags = [
      # Prevent Tailscale from injecting silent firewall bypasses, run manually for other nodes
      "--netfilter-mode=nodivert"
      "--ssh"
      "--advertise-exit-node"
    ];
    # Lets the t3code server (running as $username) configure `tailscale serve`
    extraSetFlags = [ "--operator=${username}" ];
  }
  // lib.optionalAttrs (host == "warpe") {
    extraUpFlags = [
      # WSL2 has no /dev/net/tun; tailscaled proxies the tunnel in userspace
      "--tun=userspace-networking"
      "--ssh"
    ];
    extraSetFlags = [ "--exit-node=pewter" ];
  };

  networking = {
    nftables.enable = lib.mkForce true;
    firewall = {
      enable = true;
      # Always allow traffic from Tailscale network in NixOS firewall
      trustedInterfaces = [ config.services.tailscale.interfaceName ];
      # Allow the Tailscale UDP port through the firewall
      allowedUDPPorts = [ config.services.tailscale.port ];
    };
  };

  # Force tailscaled to use nftables (Critical for clean nftables-only systems)
  # This avoids the "iptables-compat" translation layer issues.
  systemd.services.tailscaled.serviceConfig.Environment = [
    "TS_DEBUG_FIREWALL_MODE=nftables"
  ];

  # Optimization: Prevent systemd from waiting for network online
  systemd.network.wait-online.enable = lib.mkForce false;
  boot.initrd.systemd.network.wait-online.enable = lib.mkForce false;

  # Optimize performance for high-throughput exit nodes/subnet routers
  environment.systemPackages = with pkgs; [
    ethtool
  ];
  services.udev.extraRules = ''
    # Automate UDP Generic Receive Offload (GRO) for high-throughput Tailscale routing.
    # Triggers when any ethernet or wireless interface (en*|wl*) initializes,
    # enabling packet aggregation before the CPU processes the UDP stream.
    ACTION=="add", SUBSYSTEM=="net", KERNEL=="en*|wl*", RUN+="${pkgs.ethtool}/bin/ethtool -K $name rx-udp-gro-forwarding on rx-gro-list off"
  '';
}
