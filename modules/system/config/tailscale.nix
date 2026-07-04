# https://wiki.nixos.org/wiki/Tailscale
{
  config,
  pkgs,
  lib,
  ...
}:
{
  services.tailscale = {
    enable = true;
    disableUpstreamLogging = true; # disables debug logging
    # Prevent Tailscale from injecting silent firewall bypasses
    extraUpFlags = [ "--netfilter-mode=nodivert" ];
  };

  networking = {
    nftables.enable = lib.mkForce true;
    firewall = {
      enable = true;
      # Always allow traffic from Tailscale network in NixOS firewall
      trustedInterfaces = [ config.services.tailscale.interfaceName ];
      # Allow the Tailscale UDP port through the firewall
      allowedUDPPorts = [ config.services.tailscale.port ];
      # for Exit Nodes: prevents systemd from dropping routed packets
      checkReversePath = "loose";
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
    iproute2
    gawk
  ];
  services = {
    networkd-dispatcher = {
      enable = true;
      rules."50-tailscale-optimizations" = {
        onState = [ "routable" ];
        script = ''
          # Dynamically locate the primary active WAN interface routing to the internet
          WAN_INTERFACE=$(${pkgs.iproute2}/bin/ip -o route get 8.8.8.8 | ${pkgs.gawk}/bin/awk '{print $5}')

          # Apply Tailscale UDP transport layer offloading optimizations directly to that device
          if [ -n "$WAN_INTERFACE" ]; then
            ${pkgs.ethtool}/bin/ethtool -K "$WAN_INTERFACE" rx-udp-gro-forwarding on rx-gro-list off
          fi
        '';
      };
    };
    # Automate UDP Generic Receive Offload (GRO) for high-throughput Tailscale routing.
    # This udev rule triggers immediately when any ethernet interface (en*) initializes,
    # enabling packet aggregation before the CPU processes the UDP stream.
    udev.extraRules = ''
      ACTION=="add", SUBSYSTEM=="net", KERNEL=="en*", RUN+="${pkgs.ethtool}/bin/ethtool -K $name rx-udp-gro-forwarding on rx-gro-list off"
    '';
  };

}
