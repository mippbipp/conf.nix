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
              type = "EF00";
              size = "500M";
              content = {
                type = "filesystem";
                format = "vfat";
                mountpoint = "/boot";
                # Oracle ARM UEFI requires this specific mount option
                mountOptions = [ "umask=0077" ];
              };
            };
            # Root Partition
            root = {
              size = "100%";
              content = {
                type = "filesystem";
                format = "ext4";
                mountpoint = "/";
              };
            };
          };
        };
      };
    };
  };
}
