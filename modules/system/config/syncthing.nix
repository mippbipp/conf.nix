{
  lib,
  username,
  host,
  ...
}:
let
  allDevices = {
    gram = {
      id = "STSZHNC-PHDMSOV-LLJUNMR-VZHVO5X-NERCW7A-OIEO36S-Y4YVMVK-H7FRKAP";
      addresses = [
        "tcp://gram:22000"
        "dynamic"
      ];
    };
    pewter = {
      id = "POHLBBF-3AOYWFT-OK46SCB-Z4O4VHV-5NFB5MH-SX2OP5M-GNYZSTT-5VKEPQT";
      addresses = [
        "tcp://pewter:22000"
        "dynamic"
      ];
    };
  };

  remotePeers = lib.filterAttrs (name: _: name != host) allDevices;
  remotePeerNames = lib.attrNames remotePeers;
in
{
  services.syncthing = {
    enable = true;
    user = username;
    dataDir = "/home/${username}";
    configDir = "/home/${username}/.config/syncthing";
    openDefaultPorts = true;

    overrideDevices = true;
    overrideFolders = true;

    settings = {
      # Lock down privacy: strictly Tailscale P2P, no public discovery or relays
      options = {
        relaysEnabled = false;
        globalAnnounceEnabled = false;
        localAnnounceEnabled = true;
      };

      # Automatically populate peer devices
      devices = remotePeers;

      folders = {
        "things" = {
          path = "/home/${username}/things";
          devices = remotePeerNames;
          type = "sendreceive";
          ignorePerms = true; # Prevents Linux/NTFS/metadata permission loops
        };
      };
    };
  };
}
