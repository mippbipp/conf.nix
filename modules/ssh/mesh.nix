# Fleet SSH mesh views: one owner for peer and LUKS client entries.
{ lib }:
let
  # Everyone but me
  exceptSelf = hosts: host: lib.filterAttrs (name: _: name != host) hosts;

  # Owners of the pewter-LUKS recipients: the unlocksPewter Role flag.
  # One flag, two readers (mesh entries here, initrd keys on pewter), so no list
  # to drift.
  luksUnlockers = hosts: lib.attrNames (lib.filterAttrs (_: peer: peer.unlocksPewter) hosts);
in
{
  inherit exceptSelf luksUnlockers;

  # Mesh entries for dialable peers: reachable sshd, user defaults attached.
  # External records stay excluded by code, not just by default-false.
  peerEntries =
    {
      hosts,
      host,
      username,
    }:
    lib.mapAttrs (name: _: {
      hostname = name;
      user = username;
    }) (lib.filterAttrs (_: peer: peer.acceptsSsh && !peer.external) (exceptSelf hosts host));

  # Pre-boot LUKS entries, one per LUKS host, only for key holders.
  # Assumption: a single LUKS host (pewter); a second one needs per-host
  # recipient lists instead of the shared `luksUnlockers`.
  luksEntries =
    { hosts, host }:
    let
      unlockers = luksUnlockers hosts;
      luksHosts = lib.filterAttrs (_: peer: peer.luksHostname != null) (exceptSelf hosts host);
    in
    lib.optionalAttrs (builtins.elem host unlockers) (
      lib.mapAttrs' (
        name: peer:
        lib.nameValuePair "${name}-luks" {
          hostname = peer.luksHostname;
          user = "root";
          port = peer.sshPort;
          userKnownHostsFile = "~/.ssh/known_hosts.initrd";
        }
      ) luksHosts
    );
}
