{
  username,
  host,
  lib,
  globals,
  ...
}:
let
  peers = lib.filterAttrs (name: _: name != host) globals.hosts;

  peerEntries = lib.mapAttrs (name: _peer: {
    hostname = name;
    user = username;
  } // lib.optionalAttrs (_peer ? sshPort) { port = _peer.sshPort; }) peers;

  luksEntries = lib.mapAttrs' (name: peer:
    lib.nameValuePair "${name}-luks" {
      hostname = peer.luksHostname;
      user = "root";
      port = peer.sshPort or 22;
    }) (lib.filterAttrs (_: peer: peer ? luksHostname) peers);
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
    } // peerEntries // luksEntries;
  };
}
