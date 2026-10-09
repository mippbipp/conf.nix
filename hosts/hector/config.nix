{
  inputs,
  modulesPath,
  pkgs,
  ...
}:
{
  # Graviton (m7g.medium) is aarch64, matches pewter's arch
  nixpkgs.hostPlatform = "aarch64-linux";
  system.stateVersion = "26.05";

  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    inputs.disko.nixosModules.disko
    ./disko.nix
    ./users.nix
  ];

  security.sudo.wheelNeedsPassword = false;

  services = {
    amazon-ssm-agent.enable = true;
    # openssh: reachable for the Work host, hardened and port-derived by
    # modules/ssh/system.nix off the acceptsSsh Role flag.
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
