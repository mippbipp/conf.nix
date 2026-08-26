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
      root.openssh.authorizedKeys.keys = [
        globals.hosts.gram.pubkey
      ];
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
          globals.hosts.gram.pubkey
          globals.hosts.warpe.pubkey
        ];
      };
    };
  };
}
