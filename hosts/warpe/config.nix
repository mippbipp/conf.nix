# Edit this configuration file to define what should be installed on
# your system. Help is available in the configuration.nix(5) man page, on
# https://search.nixos.org/options and in the NixOS manual (`nixos-help`).

# NixOS-WSL specific options are documented on the NixOS-WSL repository:
# https://github.com/nix-community/NixOS-WSL

{
  lib,
  pkgs,
  ...
}:
{
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  imports = [
    ./users.nix
    ./work.nix
    ../../modules/system/hardware/intel-drivers.nix
    ../../modules/system/config/common.nix
    ../../modules/system/config/tailscale.nix
    ../../modules/system/config/wsl.nix
    ../../modules/theme/system.nix
    ../../modules/system/config/nix.nix
    ../../modules/system/config/programs.nix
  ];

  # --- Tailscale / MagicDNS workaround for work wsl not using tailscale DNS
  # Avoids using NextDNS global nameserver configured in tailnet (blocked by work)

  # WSL will fight systemd-resolved unless this is off.
  wsl.wslConf.network.generateResolvConf = false;
  boot.kernelModules = [ "dummy" ];

  services.resolved = {
    enable = true;
    settings = {
      Resolve = {
        MulticastDNS = "false";
        LLMNR = "false";
      };
    };
  };

  networking.nameservers = [
    "10.255.255.254" # WSL default
  ];
  systemd.services.tailscale-magicdns-split = {
    description = "Route MagicDNS to Quad100 without accepting tailnet DNS";
    after = [
      "systemd-resolved.service"
      "tailscaled.service"
      "sys-subsystem-net-devices-magicdns0.device"
    ];
    wants = [
      "systemd-resolved.service"
      "tailscaled.service"
    ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      Restart = "on-failure";
      RestartSec = "5s";
    };
    path = with pkgs; [
      coreutils
      gnused
      iproute2
      jq
      systemd
      tailscale
    ];
    script = ''
      set -euo pipefail

      if ! ip link show magicdns0 >/dev/null 2>&1; then
        ip link add magicdns0 type dummy
      fi
      ip link set magicdns0 up
      ip addr replace 172.20.0.1/32 dev magicdns0

      suffix="$(tailscale status --json | jq -r '.MagicDNSSuffix' | sed 's/\.$//')"
      if [ -z "$suffix" ] || [ "$suffix" = "null" ]; then
        echo "MagicDNSSuffix unavailable" >&2
        exit 1
      fi

      resolvectl llmnr magicdns0 no
      resolvectl mdns magicdns0 no
      resolvectl dns magicdns0 100.100.100.100
      resolvectl domain magicdns0 "$suffix" "~ts.net"
      resolvectl default-route magicdns0 no
    '';
  };
}
