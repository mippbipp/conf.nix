# Fleet registry: typed per-machine records behind one interface.
#
# Globals describes already-declared hosts (see ADR-0010); this module gives
# that description a checked shape.
#
# Host<->record correspondence (every NixOS host has a non-external record
# and vice versa) cannot see flake outputs from inside the module system, so
# it lives in the fleet-correspondence flake check instead.
{ lib, ... }:
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
      acceptsTailnetSsh = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: tailnet SSH (tailscale --ssh) is enabled toward this host.";
      };
      acceptsSsh = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: runs a reachable sshd; appears in peers' SSH mesh.";
      };
      usesWorkGit = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: carries the work GitLab identity (directory-gated ~/work/); reads the work-only sops file.";
      };
      hasRepoCheckout = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Role flag: carries a ~/conf.nix checkout; repo-gated home files resolve out-of-store.";
      };
      unlocksPewter = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: may unlock pewter pre-boot; receives the pewter-luks mesh entry and lands in pewter's initrd authorizedKeys.";
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
      unlocksPewter = true;
    };
    harpe = { };
    warpe = {
      isWorkPc = true;
      usesWorkGit = true;
      pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJFlGnfX0uWipIXc1rpZap0ZxEdGTi4s+QhxriJ5bBcM mippbipp@warpe";
    };
    pewter = {
      sshPort = 2222; # set in oracle cloud security list ingress rules, used for luks unlocking
      luksHostname = "129.146.202.171";
      syncId = "POHLBBF-3AOYWFT-OK46SCB-Z4O4VHV-5NFB5MH-SX2OP5M-GNYZSTT-5VKEPQT";
      isExitNode = true;
      remoteBuilds = true;
      acceptsTailnetSsh = true;
      acceptsSsh = true;
      usesWorkGit = true;
    };
    hector = {
      acceptsTailnetSsh = true;
      acceptsSsh = true;
      usesWorkGit = true;
      # No repo checkout by design (receives deployments via pewter);
      # repo-gated home files ship from the store instead.
      hasRepoCheckout = false;
    };
    brick = {
      external = true;
      syncId = "4Q75UQR-3BKJV5G-5DBCANF-FG5OUML-PMWS5XB-LUW2CSK-7RQX6AL-Y7KR4AI";
    };
  };
}
