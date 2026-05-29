{ host }:
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
      };
      "github.com" = {
        host = "github.com";
        hostname = "github.com";
        user = "git";
        identityFile = "~/.ssh/${host}_ed25519";
      };
      "raspberrypi" = {
        host = "raspberrypi";
        hostname = "raspberrypi.local";
        user = "pants";
        identityFile = "~/.ssh/${host}_ed25519";
      };
      "sta" = {
        host = "sta";
        hostname = "ec2-18-237-98-177.us-west-2.compute.amazonaws.com";
        user = "ubuntu";
        identityFile = "~/.ssh/sta_ed25519";
      };
    };
  };
}
