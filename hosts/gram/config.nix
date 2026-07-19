{
  pkgs,
  options,
  ...
}:
let
  inherit (import ./variables.nix) wallpaper;
in
{
  imports = [
    ./hardware.nix
    ./users.nix
    ../../modules/system/hardware/tools.nix
    ../../modules/system/hardware/nvidia-drivers.nix
    ../../modules/system/hardware/nvidia-prime-drivers.nix
    ../../modules/system/hardware/intel-drivers.nix
    ../../modules/system/hardware/mouse.nix
    ../../modules/system/config/virtualization.nix
    ../../modules/system/config/common.nix
    (import ../../modules/theme/system.nix { inherit pkgs wallpaper; })
    ../../modules/system/config/nix.nix
    ../../modules/system/config/secret.nix
    ../../modules/system/config/programs.nix
    ../../modules/system/config/resolved.nix
    ../../modules/system/config/tailscale.nix
    ../../modules/system/config/syncthing.nix
    ../../modules/system/config/printing.nix
    ../../modules/system/apps/obs.nix
    ../../modules/system/apps/libreoffice.nix
    ../../modules/system/apps/gaming.nix
    ../../modules/de/audio.nix
    ../../modules/de/hyprland/system.nix
    ../../modules/de/greetd/login.nix
    ../../modules/de/thunar/system.nix
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
    kernelModules = [
      "uinput"
    ];
    # Bootloader
    loader = {
      systemd-boot = {
        enable = true;
        editor = false;
        configurationLimit = 5;
      };
      efi.canTouchEfiVariables = true;
    };
    # Make /tmp a tmpfs
    tmp = {
      useTmpfs = false;
      tmpfsSize = "30%";
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
    networkmanager.enable = true;
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
    etc = {
      "libinput/local-overrides.quirks".text = ''
        [Never Debounce]
        MatchUdevType=mouse
        ModelBouncingKeys=1
      '';
    };
    shells = [
      pkgs.zsh # add to /etc/shells
    ];
    systemPackages = with pkgs; [
      lz4 # for zswap
      appimage-run
      networkmanagerapplet
      playerctl
      imv
    ];
  };

  services = {
    libinput.enable = true;
    fstrim.enable = true;
    flatpak.enable = true;
  };
  systemd = {
    services = {
      flatpak-repo = {
        path = [ pkgs.flatpak ];
        script = ''
          flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
          flatpak update
        '';
      };
    };
  };
  hardware.sane = {
    enable = true;
    extraBackends = [ pkgs.sane-airscan ];
    disabledDefaultBackends = [ "escl" ];
  };

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It‘s perfectly fine and recommended to leave
  # this value at the release version of the first install of this system.
  # Before changing this value read the documentation for this option
  # (e.g. man configuration.nix or on https://nixos.org/nixos/options.html).
  system.stateVersion = "23.11"; # Did you read the comment?
}
