{
  lib,
  username,
  host,
  config,
  ...
}:
let
  mesh = import ../../ssh/mesh.nix { inherit lib; };
  # One entry per peer that carries a syncId; addresses derive from the name.
  remotePeers = lib.filterAttrs (_: peer: peer.syncId != null) (mesh.exceptSelf config.fleet.hosts host);

  remoteDevices = lib.mapAttrs (name: peer: {
    id = peer.syncId;
    addresses = [
      "tcp://${name}:22000"
      "dynamic"
    ];
  }) remotePeers;

  remotePeerNames = lib.attrNames remoteDevices;
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
      devices = remoteDevices;

      folders = {
        "things" = {
          path = "/home/${username}/things";
          devices = remotePeerNames;
          type = "sendreceive";
          ignorePerms = true; # Prevents Linux/NTFS/metadata permission loops
          versioning = {
            type = "staggered";
            params = {
              cleanInterval = "3600";
              maxAge = "2592000"; # 30 days in seconds
            };
          };
        };
      };
    };
  };
}
