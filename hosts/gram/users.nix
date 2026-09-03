{
  pkgs,
  username,
  inputs,
  ...
}:

{
  services.userborn.enable = false;
  users = {
    mutableUsers = true;
    users = {
      "${username}" = {
        homeMode = "755";
        isNormalUser = true;
        description = username;
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
          t3code.desktop # see flake.nix
        ];
        openssh.authorizedKeys.keys = [ ];
      };
    };
  };
}
