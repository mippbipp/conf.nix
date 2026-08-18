{
  pkgs,
  username,
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
          "wheel"
          "scanner"
          "lp"
          "input"
          "uinput"
        ];
        shell = pkgs.zsh;
        ignoreShellProgramCheck = true;
        openssh.authorizedKeys.keys = [ ];
      };
    };
  };
}
