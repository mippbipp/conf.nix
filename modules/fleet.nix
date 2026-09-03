# Fleet registry: typed per-machine records behind one interface.
#
# Globals describes already-declared hosts (see ADR-0010); this module gives
# that description a checked shape. Role flags carry types and defaults, so a
# typo'd flag is an eval error instead of a silent `or false` fallback, and
# unknown attrs are rejected by the submodule type. Wired once in
# mkHostConfig; the merged records are re-exposed under the existing
# `globals` arg name, so consumers keep their call sites.
#
# Host<->record correspondence (every NixOS host has a non-external record
# and vice versa) cannot see flake outputs from inside the module system, so
# it lives in the fleet-correspondence flake check instead.
{ config, lib, ... }:
let
  hostRecord = {
    options = {
      isExitNode = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: advertises as tailnet exit node.";
      };
      isWorkPc = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: sits on the corporate network; refuses the Tailnet global nameserver and routes MagicDNS only.";
      };
      canSsh = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: tailnet SSH is enabled toward this host.";
      };
      remoteBuilds = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: builds for itself; nrs targets it with --build-host.";
      };
      external = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Sync-only peer with no NixOS declaration. Kept as sync peer, skipped by the SSH mesh.";
      };
      pubkey = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "SSH public key other hosts pin (e.g. pewter initrd access).";
      };
      luksHostname = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Pre-boot address for LUKS unlocking entries.";
      };
      syncId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Syncthing device ID. Null means the host carries no synced folders.";
      };
      sshPort = lib.mkOption {
        type = lib.types.port;
        default = 22;
        description = "SSH port other hosts dial.";
      };
    };
  };
in
{
  options.fleet.hosts = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule hostRecord);
    default = { };
    description = "Per-machine Globals records, keyed by host name.";
  };

  config.fleet.hosts = {
    gram = {
      pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIyaPm21KDiQAXbzoG0IS7KO8rwcrP2ZqwJjW6uvh29A wovw@gram";
      syncId = "STSZHNC-PHDMSOV-LLJUNMR-VZHVO5X-NERCW7A-OIEO36S-Y4YVMVK-H7FRKAP";
    };
    harpe = { };
    warpe = {
      isWorkPc = true;
      pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJFlGnfX0uWipIXc1rpZap0ZxEdGTi4s+QhxriJ5bBcM mippbipp@warpe";
    };
    pewter = {
      sshPort = 2222; # set in oracle cloud security list ingress rules, used for luks unlocking
      luksHostname = "129.146.202.171";
      syncId = "POHLBBF-3AOYWFT-OK46SCB-Z4O4VHV-5NFB5MH-SX2OP5M-GNYZSTT-5VKEPQT";
      isExitNode = true;
      remoteBuilds = true;
      canSsh = true;
    };
    hector = {
      canSsh = true;
    };
    brick = {
      external = true;
      syncId = "4Q75UQR-3BKJV5G-5DBCANF-FG5OUML-PMWS5XB-LUW2CSK-7RQX6AL-Y7KR4AI";
    };
  };
}
