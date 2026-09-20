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
        shell = pkgs.zsh;
        ignoreShellProgramCheck = true;
        openssh.authorizedKeys.keys = [ ];
      };
    };
  };
}
