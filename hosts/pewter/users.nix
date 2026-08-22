{ pkgs, username, ... }:

let
  inherit (import ./variables.nix) gitUsername;
  inherit (import ../../modules/globals.nix) gram;
in
{
  services.userborn.enable = false;
  users = {
    mutableUsers = true;
    users = {
      root.openssh.authorizedKeys.keys = [
        gram.pubkey
      ];
      "${username}" = {
        homeMode = "755";
        isNormalUser = true;
        description = gitUsername;
        extraGroups = [
          "wheel"
          "networkmanager"
        ];
        shell = pkgs.zsh;
        ignoreShellProgramCheck = true;
        openssh.authorizedKeys.keys = [
          gram.pubkey
        ];
      };
    };
  };
}
