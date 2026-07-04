{
  inputs,
  modulesPath,
  pkgs,
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
    ../../modules/system/config/common.nix
    ../../modules/system/config/nix.nix
    ../../modules/system/config/programs.nix
    ../../modules/system/config/resolved.nix
    ../../modules/system/config/tailscale.nix
  ];

  security.sudo.wheelNeedsPassword = false;
  services = {
    fstrim.enable = false; # managed by Oracle's underlying SAN
    tailscale.useRoutingFeatures = "both"; # enable IP forwarding as exit node
    openssh = {
      # Enable root SSH explicitly
      enable = true;
      settings.PermitRootLogin = "prohibit-password";
      settings.PasswordAuthentication = false;
      openFirewall = true;
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
          enable = true;
          port = 2222;
          hostKeys = [ "/etc/secrets/initrd/ssh_host_ed25519_key" ];
          authorizedKeys = [
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIyaPm21KDiQAXbzoG0IS7KO8rwcrP2ZqwJjW6uvh29A wovw@gram"
          ];
        };
      };
    };
  };

  # Oracle Cloud dynamically assigns the IP/Gateway via DHCP
  networking.useDHCP = true;
}
