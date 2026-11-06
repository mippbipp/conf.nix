{
  inputs,
  pkgs,
  ...
}:
{
  imports = [
    inputs.lanzaboote.nixosModules.lanzaboote
  ];

  nixpkgs.overlays = [
    inputs.nix-cachyos-kernel.overlays.pinned
  ];

  environment.systemPackages = [
    # For debugging and troubleshooting Secure Boot.
    pkgs.sbctl
  ];

  boot = {
    lanzaboote = {
      enable = true;
      pkiBundle = "/var/lib/sbctl";
      settings.timeout = 1;
    };

    # This Comet Lake i5-10500H has avx2/bmi1/bmi2/fma/movbe, i.e. x86-64-v3
    # Verify after each switch with:
    #   zcat /proc/config.gz | grep CONFIG_X86_64_VERSION   # expect 3
    kernelPackages = pkgs.cachyosKernels.linuxPackages-cachyos-latest-lto-x86_64-v3;
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
        # Lanzaboote currently replaces the systemd-boot module.
        enable = false;
        editor = false;
        configurationLimit = 5;
      };
      efi.canTouchEfiVariables = true;
    };
    initrd.systemd.tpm2 = {
      # Stage-1 TPM2 defaults to boot.initrd.systemd.package.withTpm2Units.
      # Left on, it costs ~0.9s at boot against a TPM that fails with
      # TPM_RC_NV_SPACE ("NV index space is exhausted") anyway.
      enable = false;
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
}
