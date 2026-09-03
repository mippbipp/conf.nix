{
  username,
  host,
  lib,
  globals,
  ...
}:
let
  mesh = import ./mesh.nix { inherit lib; };
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
    // mesh.peerEntries { hosts = globals.hosts; inherit host username; }
    // mesh.luksEntries { hosts = globals.hosts; inherit host; };
  };
}
