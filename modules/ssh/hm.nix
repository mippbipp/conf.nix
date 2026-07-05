{
  username,
  host,
  lib,
  ...
}:
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
    // lib.optionalAttrs (host == "gram") {
      "pewter" = {
        hostname = "pewter";
        user = username;
      };
      "pewter-luks" = {
        hostname = "129.146.202.171";
        user = "root";
        port = 2222;
      };
    };
  };
}
