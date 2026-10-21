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
          "wheel"
        ];
        shell = pkgs.zsh;
        ignoreShellProgramCheck = true;
        packages = with pkgs; [
          rclone
          google-chrome
          qbittorrent
          lunar-client
          yt-dlp
          gptfdisk
          zoom-us
          discord
          code-cursor
          inputs.xmcl.packages.${pkgs.stdenv.hostPlatform.system}.default
          onlyoffice-desktopeditors
        ];
        openssh.authorizedKeys.keys = [ ];
      };
    };
  };
}
