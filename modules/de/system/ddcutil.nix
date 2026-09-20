{ username, pkgs, ... }: {
  # ddcutil
  hardware.i2c.enable = true;
  users.users."${username}".extraGroups = [ "i2c" ];
  environment.systemPackages = [ pkgs.i2c-tools ];
}
