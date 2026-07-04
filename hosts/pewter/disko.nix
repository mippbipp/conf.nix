{
  disko.devices = {
    disk = {
      main = {
        # Oracle block volumes attach as /dev/sda
        device = "/dev/sda";
        type = "disk";
        content = {
          type = "gpt";
          partitions = {
            # UEFI Boot Partition
            ESP = {
              label = "EFI";
              name = "ESP";
              size = "512M";
              type = "EF00";
              content = {
                type = "filesystem";
                format = "vfat";
                mountpoint = "/boot";
                # Oracle ARM UEFI requires this specific mount option
                mountOptions = [ "umask=0077" ];
              };
            };
            luks = {
              size = "100%";
              content = {
                type = "luks";
                name = "crypted";
                # Tells disko where to look for the key during automated kexec formatting
                passwordFile = "/tmp/secret.key";
                # binds the inner Btrfs filesystem to the decrypted container
                content = {
                  type = "btrfs";
                  extraArgs = [ "-f" ]; # Force overwrite if partitions exist
                  subvolumes = {
                    "@" = {
                      mountpoint = "/";
                      mountOptions = [
                        "compress=zstd"
                        "noatime"
                      ];
                    };
                    "@home" = {
                      mountpoint = "/home";
                      mountOptions = [
                        "compress=zstd"
                        "noatime"
                      ];
                    };
                    "@nix" = {
                      mountpoint = "/nix";
                      mountOptions = [
                        "compress=zstd"
                        "noatime"
                      ];
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
  };
}
