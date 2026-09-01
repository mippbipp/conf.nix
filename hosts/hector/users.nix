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
          "networkmanager"
        ];
        shell = pkgs.zsh;
        ignoreShellProgramCheck = true;
        openssh.authorizedKeys.keys = [
          globals.hosts.warpe.pubkey
        ];
      };
    };
  };
}
