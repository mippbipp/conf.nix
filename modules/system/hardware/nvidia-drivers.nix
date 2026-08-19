{
  lib,
  pkgs,
  config,
  ...
}:
with lib;
let
  cfg = config.drivers.nvidia;
in
{
  options.drivers.nvidia = {
    enable = mkEnableOption "Enable Nvidia Drivers";
  };

  config = mkIf cfg.enable {
    # https://wiki.nixos.org/wiki/NVIDIA#Kernel_modules_from_NVIDIA
    services.xserver.videoDrivers = [ "nvidia" ];

    # https://www.ddcutil.com/nvidia/
    boot.extraModprobeConfig = "options nvidia NVreg_RegistryDwords=RMUseSwI2c=0x01;RMI2cSpeed=100";

    # OpenGL
    hardware.graphics = {
      enable = true;
      extraPackages = with pkgs; [
        nvidia-vaapi-driver
        egl-wayland # https://wiki.hypr.land/Nvidia/#further-installation
        libvdpau
        libGL
      ];
    };

    hardware.nvidia = {
      # Modesetting is required.
      modesetting.enable = true;
      powerManagement = {
        # Nvidia power management. Experimental, and can cause sleep/suspend to fail.
        enable = true;
        # Fine-grained power management. Turns off GPU when not in use.
        # Experimental and only works on modern Nvidia GPUs (Turing or newer).
        finegrained = true; # requires prime offload mode (see nvidia-prime-drivers.nix)
      };
      # Use the NVidia open source kernel module (not to be confused with the
      # independent third-party "nouveau" open source driver).
      # Support is limited to the Turing and later architectures. Full list of
      # supported GPUs is at:
      # https://github.com/NVIDIA/open-gpu-kernel-modules#compatible-gpus
      # Only available from driver 515.43.04+
      # Currently alpha-quality/buggy, so false is currently the recommended setting.
      open = true;
      # Enable the Nvidia settings menu,
      # accessible via `nvidia-settings`.
      nvidiaSettings = true;
      # Optionally, you may need to select the appropriate driver version for your specific GPU.
      package = config.boot.kernelPackages.nvidiaPackages.stable;
    };
  };
}
