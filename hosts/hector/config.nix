{
  inputs,
  modulesPath,
  pkgs,
  ...
}:
{
  # Graviton (m7g.medium) is aarch64 — matches pewter's arch
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
    ../../modules/system/config/tailscale/default.nix
    ../../modules/system/config/tailscale/t3code-serve.nix
  ];

  security.sudo.wheelNeedsPassword = false;

  services = {
    amazon-ssm-agent.enable = true;
    openssh = {
      enable = true;
      settings.PermitRootLogin = "prohibit-password";
      settings.PasswordAuthentication = false;
      openFirewall = true;
    };
  };

  boot = {
    kernelPackages = pkgs.linuxPackages_latest;
    supportedFilesystems = [ "btrfs" ];
    loader = {
      systemd-boot.enable = true;
      efi.canTouchEfiVariables = true;
    };
    initrd.availableKernelModules = [
      "nvme"
      "virtio_net"
      "virtio_pci"
      "virtio_scsi"
      "virtio_blk"
      "ahci"
    ];
  };

  networking = {
    useDHCP = true;
  };
}
