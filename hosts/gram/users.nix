{
  pkgs,
  username,
  inputs,
  ...
}:

let
  inherit (import ./variables.nix) gitUsername;
in
{
  services.userborn.enable = false;
  users = {
    mutableUsers = true;
    users = {
      "${username}" = {
        homeMode = "755";
        isNormalUser = true;
        description = gitUsername;
        extraGroups = [
          "networkmanager"
          "wheel"
          "scanner"
          "lp"
          "input"
          "uinput"
          "i2c"
          "dialout"
        ];
        shell = pkgs.zsh;
        ignoreShellProgramCheck = true;
        packages = with pkgs; [
          rclone
          google-chrome
          qbittorrent
          spotify
          lunar-client
          yt-dlp
          gptfdisk
          zoom-us
          discord
          code-cursor
          inputs.xmcl.packages.${pkgs.stdenv.hostPlatform.system}.default
        ];
        openssh.authorizedKeys.keys = [ ];
      };
    };
  };
}
