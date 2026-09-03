# Fleet SSH mesh views: one owner for peer and LUKS client entries.
#
# Interface: pure functions of the merged fleet records plus the local host
# name (never `config`: Home Manager only receives records as data). Returns
# plain ssh-config entry attrsets; `hm.nix` merges them into
# programs.ssh.settings, and pewter's initrd reads `luksUnlockers` for its
# authorizedKeys so recipients and keys share one owner (the unlocksPewter
# Role flag). Shared thinly — imported by hm.nix, syncthing.nix, nrs.nix, and
# pewter config only: syncthing and nrs reuse `exceptSelf` with their own
# predicates (`syncId != null`, `remoteBuilds`); nrs targets exclude self, so
# a remote build always means ssh to another machine, never to self.
{ lib }:
let
  # Everyone but me; capability predicates stay with the callers.
  exceptSelf = hosts: host: lib.filterAttrs (name: _: name != host) hosts;

  # Single owner of the pewter-LUKS recipients: the unlocksPewter Role flag.
  # One flag, two readers (mesh entries here, initrd keys on pewter) — no list
  # to drift. attrNames forces every record, so evaluation touches the flag.
  luksUnlockers = hosts: lib.attrNames (lib.filterAttrs (_: peer: peer.unlocksPewter) hosts);
in
{
  inherit exceptSelf luksUnlockers;

  # Mesh entries for dialable peers: reachable sshd, user defaults attached.
  # External records stay excluded by code, not just by default-false.
  peerEntries =
    { hosts, host, username }:
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
    lib.optionalAttrs (builtins.elem host unlockers) (lib.mapAttrs' (
      name: peer:
      lib.nameValuePair "${name}-luks" {
        hostname = peer.luksHostname;
        user = "root";
        port = peer.sshPort;
        userKnownHostsFile = "~/.ssh/known_hosts.initrd";
      }
    ) luksHosts);
}
