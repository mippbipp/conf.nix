{ host, lib, ... }:
{
  boot = {
    loader.timeout = 1;
    initrd = {
      verbose = false;
      systemd = {
        enable = true;
        network.wait-online.enable = false;
      };
    };
    kernelParams = [
      "quiet" # Reduce console output
      "udev.loglevel=3" # Only show errors
    ];
    consoleLogLevel = 0;

    # Optimize module loading
    kernel.sysctl = {
      # Reduce swappiness for SSD systems
      "vm.swappiness" = lib.mkDefault 10;
      # Improve responsiveness
      "vm.vfs_cache_pressure" = lib.mkDefault 50;
    };
  };

  # Select internationalisation properties.
  i18n = {
    defaultLocale = "en_US.UTF-8";
    extraLocaleSettings = {
      LC_ADDRESS = "en_US.UTF-8";
      LC_IDENTIFICATION = "en_US.UTF-8";
      LC_MEASUREMENT = "en_US.UTF-8";
      LC_MONETARY = "en_US.UTF-8";
      LC_NAME = "en_US.UTF-8";
      LC_NUMERIC = "en_US.UTF-8";
      LC_PAPER = "en_US.UTF-8";
      LC_TELEPHONE = "en_US.UTF-8";
      LC_TIME = "en_US.UTF-8";
    };
  };

  networking = {
    hostName = host;
    nftables.enable = true;
  };

  # Security / Polkit
  security = {
    rtkit.enable = true;
    polkit.enable = true;
    polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
        if (
          subject.isInGroup("users")
            && (
              action.id == "org.freedesktop.login1.reboot" ||
              action.id == "org.freedesktop.login1.reboot-multiple-sessions" ||
              action.id == "org.freedesktop.login1.power-off" ||
              action.id == "org.freedesktop.login1.power-off-multiple-sessions"
            )
          )
        {
          return polkit.Result.YES;
        }
      })
    '';
  };

  systemd = {
    services = {
      # Don't wait for udev to settle
      systemd-udev-settle.enable = false;

      # Prevent hanging on shutdown
      usbmuxd.serviceConfig = {
        TimeoutStopSec = 5;
        KillMode = "mixed";
      };

      # Enable parallel startup for more services
      systemd-journal-flush.after = lib.mkForce [ ];
      systemd-tmpfiles-setup.after = lib.mkForce [ ];

      # Optimize to start on-demand rather than at boot
      avahi-daemon.wantedBy = lib.mkForce [ ]; # socket activation
      bluetooth.wantedBy = lib.mkForce [ ]; # blueman
      upower.wantedBy = lib.mkForce [ ]; # starts when battery status queried
    };
    network.wait-online.enable = false; # Don't wait for network before considering boot complete
    sockets.avahi-daemon.wantedBy = [ "sockets.target" ]; # Will start automatically when needed via socket activation

    # Disable core dumps (slight performance improvement)
    coredump.enable = lib.mkDefault false;

    # Reduce default timeouts for all services
    settings.Manager = {
      DefaultTimeoutStartSec = 30;
      DefaultTimeoutStopSec = 15;
      DefaultTimeoutAbortSec = 15;
    };

    tmpfiles.rules = [
      "d /tmp 1777 root root 7d"
    ];
  };

  # Reduce journal size and improve performance
  services.journald.extraConfig = ''
    SystemMaxUse=100M
    RuntimeMaxUse=50M
    MaxRetentionSec=1week
  '';

  environment.localBinInPath = true;
}
