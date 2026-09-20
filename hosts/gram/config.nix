{
  pkgs,
  options,
  ...
}:
{
  imports = [
    ./hardware.nix
    ./users.nix
    ../../modules/system/config/sops.nix
    ../../modules/system/hardware/tools.nix
    ../../modules/system/hardware/nvidia-drivers.nix
    ../../modules/system/hardware/nvidia-prime-drivers.nix
    ../../modules/system/hardware/intel-drivers.nix
    ../../modules/system/config/virtualization.nix
    ../../modules/system/config/common.nix
    ../../modules/theme/system.nix
    ../../modules/system/config/nix.nix
    ../../modules/system/config/secret.nix
    ../../modules/system/config/programs.nix
    ../../modules/system/config/dns.nix
    ../../modules/system/config/tailscale/default.nix
    ../../modules/system/config/syncthing.nix
    ../../modules/system/config/printing.nix
    ../../modules/de/apps/system/obs.nix
    ../../modules/de/apps/system/onlyoffice.nix
    ../../modules/de/apps/system/gaming.nix
    ../../modules/de/system/default.nix
    ../../modules/de/hyprland/system.nix
    ../../modules/de/greetd/login.nix
    ../../modules/de/apps/thunar/system.nix
    ../../modules/de/computer-use-linux/system.nix
    ../../modules/ssh/system.nix
  ];

  boot = {
    kernelPackages = pkgs.cachyosKernels.linuxPackages-cachyos-bore-lto;
    kernelParams = [
      "8250.nr_uarts=0" # disable unused legacy serial ports

      # https://wiki.nixos.org/wiki/Swap#Zswap_swap_cache
      "zswap.enabled=1" # enables zswap
      "zswap.compressor=lz4" # compression algorithm
      "zswap.max_pool_percent=20" # maximum percentage of RAM that zswap is allowed to use

      "pci=noaer" # disable AER for non-fatal errors
    ];
    loader = {
      systemd-boot = {
        enable = true;
        editor = false;
        configurationLimit = 5;
      };
      efi.canTouchEfiVariables = true;
    };
    # Appimage Support
    binfmt.registrations.appimage = {
      wrapInterpreterInShell = false;
      interpreter = "${pkgs.appimage-run}/bin/appimage-run";
      recognitionType = "magic";
      offset = 0;
      mask = ''\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff'';
      magicOrExtension = ''\x7fELF....AI\x02'';
    };
  };

  drivers = {
    # Extra Module Options
    intel.enable = true;
    nvidia.enable = true;
    nvidia-prime.enable = true;
  };

  # Enable networking
  networking = {
    timeServers = options.networking.timeServers.default ++ [ "pool.ntp.org" ];
    firewall = {
      enable = true;
      # Open ports in the firewall.
      allowedTCPPorts = [
        25565 # mc lan
      ];
      allowedUDPPorts = [
        25565 # mc lan
      ];
    };
  };

  programs = {
    nix-ld = {
      libraries = with pkgs; [
        libplist
        libimobiledevice
      ];
    };
  };

  environment = {
    shells = [
      pkgs.zsh # add to /etc/shells
    ];
    systemPackages = with pkgs; [
      lz4 # for zswap
      appimage-run
      playerctl
      imv
    ];
  };

  services = {
    fstrim.enable = true;
  };

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It‘s perfectly fine and recommended to leave
  # this value at the release version of the first install of this system.
  # Before changing this value read the documentation for this option
  # (e.g. man configuration.nix or on https://nixos.org/nixos/options.html).
  system.stateVersion = "23.11"; # Did you read the comment?
}
