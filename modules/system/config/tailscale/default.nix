# https://wiki.nixos.org/wiki/Tailscale
{
  config,
  pkgs,
  lib,
  host,
  username,
  globals,
  ...
}:
let
  self = globals.hosts.${host} or { };
  isExitNode = self.isExitNode or false;
  isWorkPc = self.isWorkPc or false;
in
{
  services.tailscale = lib.mkMerge [
    # Base config for every host
    {
      enable = true;
      disableUpstreamLogging = true; # disables debug logging
      useRoutingFeatures = "client";
    }

    # Exit-node role
    (lib.mkIf isExitNode {
      useRoutingFeatures = lib.mkForce "both";
      authKeyFile = "/var/lib/tailscale/authkey";
      extraUpFlags = [
        "--netfilter-mode=nodivert"
        "--advertise-exit-node"
        "--ssh"
      ];
      extraSetFlags = [
        "--operator=${username}"
      ];
    })
    (lib.mkIf isWorkPc {
      extraUpFlags = [ "--accept-dns=false" ];
      extraSetFlags = [
        "--accept-dns=false"
      ];
    })
  ];

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
