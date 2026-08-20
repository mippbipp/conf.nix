{ pkgs, ... }:
{
  programs = {
    nix-ld.enable = true;
    gnupg.agent = {
      enable = true;
      enableSSHSupport = true;
    };
  };

  environment.systemPackages = with pkgs; [
    pinentry-curses
    whois
    file
    vim
    killall
    git
    unzip
    unrar
    pciutils
    usbutils
    ripgrep
    fd
    bat
    pkg-config
    nmap
    nh
    tree
    glib
    fzf
    zip
    fastfetch
    jq
    curl
    wget
    ncdu
    officecli
    dig
    openssl
    traceroute
  ];

  services = {
    automatic-timezoned.enable = true;
    upower.enable = true;
  };
}
