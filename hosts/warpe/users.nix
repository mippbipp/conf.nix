{
  pkgs,
  username,
  globals,
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
        description = globals.user.name;
        extraGroups = [
          "wheel"
          "scanner"
          "lp"
          "input"
          "uinput"
        ];
        shell = pkgs.zsh;
        ignoreShellProgramCheck = true;
        openssh.authorizedKeys.keys = [
          globals.hosts.gram.pubkey
        ];
      };
    };
  };
}
