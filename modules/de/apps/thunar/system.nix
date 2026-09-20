{ pkgs, ... }:
{
  programs.xfconf.enable = true;
  environment.systemPackages = with pkgs; [
    thunar
    thunar-archive-plugin
    thunar-volman
  ];

  services = {
    gvfs.enable = true; # Mount, trash, etc
    tumbler.enable = true; # Thumbnail support for images
  };
}
