# Edit this configuration file to define what should be installed on
# your system. Help is available in the configuration.nix(5) man page, on
# https://search.nixos.org/options and in the NixOS manual (`nixos-help`).

# NixOS-WSL specific options are documented on the NixOS-WSL repository:
# https://github.com/nix-community/NixOS-WSL

{
  lib,
  ...
}:
{
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  imports = [
    ./users.nix
    ./work.nix
    ../../modules/system/config/sops.nix
    ../../modules/system/config/common.nix
    ../../modules/system/config/wsl
    ../../modules/system/config/tailscale/default.nix
    ../../modules/system/config/dns.nix
    ../../modules/theme/system.nix
    ../../modules/system/config/nix.nix
    ../../modules/system/config/programs.nix
  ];
}
