{
  username,
  host,
  lib,
  ...
}:
let
  inherit (import ../globals.nix) pewter;
in
{
  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;
    settings = {
      "*" = {
        forwardAgent = false;
        serverAliveInterval = 0;
        serverAliveCountMax = 3;
        compression = false;
        addKeysToAgent = "no";
        hashKnownHosts = false;
        userKnownHostsFile = "~/.ssh/known_hosts";
        controlMaster = "no";
        controlPath = "~/.ssh/master-%r@%n:%p";
        controlPersist = "no";
        identityFile = "~/.ssh/${host}_ed25519";
        identitiesOnly = "yes";
      };
      "github.com" = {
        host = "github.com";
        hostname = "github.com";
        user = "git";
      };
    }
    // lib.optionalAttrs (host == "gram" || host == "warpe") {
      "pewter" = {
        hostname = pewter.name;
        user = username;
        port = pewter.sshPort;
      };
      "pewter-luks" = {
        hostname = pewter.luksHostname;
        user = "root";
        port = pewter.sshPort;
      };
    }
    // lib.optionalAttrs (host == "gram") {
      "warpe" = {
        hostname = "warpe";
        user = username;
      };
    };
  };
}
