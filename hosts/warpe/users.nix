{
  pkgs,
  username,
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
          "scanner"
          "lp"
          "input"
          "uinput"
        ];
        shell = pkgs.zsh;
        ignoreShellProgramCheck = true;
        packages = with pkgs; [
          t3code.desktop
          awscli2
          ssm-session-manager-plugin
        ];
      };
    };
  };
}
