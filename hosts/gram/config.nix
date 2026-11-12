{
  options,
  pkgs,
  ...
}:
{
  imports = [
    ./hardware.nix
    ./boot.nix
    ./users.nix
    ../../modules/system/hardware/tools.nix
    ../../modules/system/hardware/nvidia-drivers.nix
    ../../modules/system/hardware/nvidia-prime-drivers.nix
    ../../modules/system/hardware/intel-drivers.nix
    ../../modules/system/config/virtualization.nix
    ../../modules/theme/system.nix
    ../../modules/system/config/secret.nix
    ../../modules/system/config/syncthing.nix
    ../../modules/system/config/printing.nix
    ../../modules/de/apps/system/obs.nix
    ../../modules/de/apps/system/gaming.nix
    ../../modules/de/apps/system/chromium.nix
    ../../modules/de/system
    ../../modules/de/hyprland/system.nix
    ../../modules/de/apps/thunar/system.nix
  ];

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

  systemd.tpm2 = {
    # Nothing on this host consumes TPM PCR measurements. Root is plain ext4
    # (no cryptenroll auto-unlock), /etc/credstore.encrypted is empty, and
    # lanzaboote's measuredBoot is off, so systemd-pcrlock seals nothing.
    # Secure Boot signature verification is firmware-side and unaffected.
    #
    # NixOS defaults this on. Left enabled it costs ~0.9s at boot plus ~0.7s
    # on every login via systemd-pcrlogin@.service, and both units fail anyway
    # with TPM_RC_NV_SPACE ("NV index space is exhausted").
    enable = false;
  };

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It‘s perfectly fine and recommended to leave
  # this value at the release version of the first install of this system.
  # Before changing this value read the documentation for this option
  # (e.g. man configuration.nix or on https://nixos.org/nixos/options.html).
  system.stateVersion = "23.11";
}
