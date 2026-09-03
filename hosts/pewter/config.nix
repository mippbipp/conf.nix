{
  inputs,
  modulesPath,
  pkgs,
  globals,
  ...
}:
{
  # ARM architecture for the Oracle VM.Standard.A1.Flex shape
  nixpkgs.hostPlatform = "aarch64-linux";
  system.stateVersion = "26.05";

  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    inputs.disko.nixosModules.disko
    ./disko.nix
    ./users.nix
    ../../modules/system/config/sops.nix
    ../../modules/system/config/common.nix
    ../../modules/system/config/nix.nix
    ../../modules/system/config/programs.nix
    ../../modules/system/config/dns.nix
    ../../modules/system/config/tailscale/default.nix
    ../../modules/system/config/tailscale/t3code-serve.nix
    ../../modules/system/config/syncthing.nix
    ./attic.nix
    ./flake-update.nix
  ];

  security.sudo.wheelNeedsPassword = false;
  services = {
    fstrim.enable = false; # managed by Oracle's underlying SAN
    openssh = {
      # Enable root SSH explicitly
      enable = true;
      settings.PermitRootLogin = "prohibit-password";
      settings.PasswordAuthentication = false;
      openFirewall = true;
      ports = [
        globals.hosts.pewter.sshPort
      ];
    };
  };

  # Standard bootloader configuration for UEFI on Oracle ARM
  boot = {
    kernelPackages = pkgs.linuxPackages_latest;
    supportedFilesystems = [ "btrfs" ];
    loader = {
      systemd-boot.enable = true;
      efi.canTouchEfiVariables = true;
    };
    initrd = {
      # Load network card drivers early for Oracle's ARM instances
      availableKernelModules = [
        "nvme"
        "ahci"
        "virtio_net"
        "virtio_pci"
        "virtio_scsi"
        "virtio_blk"
      ];
      kernelModules = [
        "btrfs"
        "dm-crypt"
      ];
      network = {
        enable = true;
        ssh = {
          # Enable root SSH for LUKS unlocking
          enable = true;
          port = globals.hosts.pewter.sshPort;
          hostKeys = [ "/etc/secrets/initrd/ssh_host_ed25519_key" ];
          authorizedKeys = [
            globals.hosts.gram.pubkey
          ];
        };
      };
    };
  };

  networking = {
    # Oracle Cloud dynamically assigns the IP/Gateway via DHCP
    useDHCP = true;
    nftables = {
      enable = true;
      tables = {
        # Custom NAT table to handle routing between Tailscale and Public Internet
        "pewter-nat" = {
          family = "ip";
          content = ''
            chain postrouting {
              type nat hook postrouting priority srcnat; policy accept;
              # IP Masquerading: Translates node traffic into exit node's public IP
              # "enp0s6" is the public interface name in `ip a` matching VNIC's MAC address
              oifname "enp0s6" masquerade
            }

            chain forward {
              type filter hook forward priority filter; policy accept;
              # MTU/MSS Clamping: Automatically shrinks packets to fit perfectly inside the WireGuard tunnel
              tcp flags syn tcp option maxseg size set rt mtu
            }
          '';
        };
      };
    };
  };
}
