{
  inputs,
  modulesPath,
  pkgs,
  ...
}:

{
  # ARM architecture for the Oracle VM.Standard.A1.Flex shape
  nixpkgs.hostPlatform = "aarch64-linux";
  system.stateVersion = "24.05";

  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    inputs.disko.nixosModules.disko
    ./disko.nix
    ./users.nix
    ../../modules/system/config/common.nix
    ../../modules/system/config/nix.nix
    ../../modules/system/config/programs.nix
    ../../modules/system/config/resolved.nix
  ];

  # Enable root SSH explicitly
  services.openssh = {
    enable = true;
    settings.PermitRootLogin = "prohibit-password";
    settings.PasswordAuthentication = false;
    openFirewall = true;
  };

  # Standard bootloader configuration for UEFI on Oracle ARM
  boot = {
    kernelPackages = pkgs.linuxPackages_latest;
    loader = {
      systemd-boot.enable = true;
      efi.canTouchEfiVariables = true;
    };
  };

  # Oracle Cloud dynamically assigns the IP/Gateway via DHCP
  networking.useDHCP = true;
}
