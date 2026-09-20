{ pkgs, username, ... }:
{
  networking.networkmanager.enable = true;
  environment.systemPackages = with pkgs; [
    networkmanagerapplet
  ];

  users.users."${username}".extraGroups = [ "networkmanager" ];
}
