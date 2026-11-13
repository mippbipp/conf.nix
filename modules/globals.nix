# Globals: the single source for facts that outlive any one module.
#
# Evaluated once in flake.nix with lib.evalModules. Per-machine records are
# typed so a typo'd or mistyped Role flag fails evaluation.
#
# Globals describes already-declared hosts (see ADR-0010). Host<->record
# correspondence (every NixOS host has a non-external record and vice versa)
# cannot see flake outputs from in here, so it lives in the
# fleet-correspondence flake check instead.
{ lib, ... }:
let
  hostRecord = {
    options = {
      isExitNode = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: advertises as tailnet exit node.";
      };
      isServer = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: always-on server";
      };
      hasDE = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: runs a desktop environment";
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
      isPersonalHost = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: may hold the shared age identity and personal secrets. Not isWorkPc, which is a DNS role; warpe is both.";
      };
      usesWorkGit = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Role flag: carries the work GitLab identity (directory-gated ~/work/); reads the work-only sops file.";
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
  plain =
    description:
    lib.mkOption {
      type = lib.types.raw;
      inherit description;
    };
in
{
  options = {
    user = plain "Primary user identity.";
    nextdns = plain "NextDNS profile and per-host DoT endpoints.";
    cache = plain "Attic and upstream binary caches.";
    tailnet = plain "Tailnet identity.";
    hosts = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule hostRecord);
      default = { };
      description = "Per-machine records, keyed by host name.";
    };
  };

  config = {
    user.name = "mippbipp"; # also matches git username

    nextdns = rec {
      id = "7b9721";
      DNS = host: [
        "45.90.28.0#${host}-${id}.dns.nextdns.io"
        "2a07:a8c0::#${host}-${id}.dns.nextdns.io"
        "45.90.30.0#${host}-${id}.dns.nextdns.io"
        "2a07:a8c1::#${host}-${id}.dns.nextdns.io"
      ];
    };

    # Attic cache: the single owner for every cache string in the flake.
    # Structured URL/key pairs (positional lists drift); the fleet entry is
    # derived from endpoint/cacheName so the three spellings of the own cache
    # (host, URL, cache:ref) collapse to two strings. Consumers (nix.nix pull
    # lists, attic.nix serving path, nrs push) interpolate the derived
    # values; the attic-cache-sync flake check pins the Build gate YAML.
    cache = rec {
      host = "cache.mippbipp.com";
      endpoint = "https://${host}";
      cacheName = "fleet";
      caches = [
        {
          url = "${endpoint}/${cacheName}";
          key = "fleet:6knXbqLkC7Mgd7CImcsLqeTQ27Y+7E7nBLx/hQgCHGY=";
        }
        {
          url = "https://hyprland.cachix.org";
          key = "hyprland.cachix.org-1:a7pgxzMz7+chwVL3/pzj6jIBMioiJM7ypFP8PwtkuGc=";
        }
        {
          url = "https://winapps.cachix.org/";
          key = "winapps.cachix.org-1:HI82jWrXZsQRar/PChgIx1unmuEsiQMQq+zt05CD36g=";
        }
        {
          url = "https://vicinae.cachix.org";
          key = "vicinae.cachix.org-1:1kDrfienkGHPYbkpNj1mWTr7Fm1+zcenzgTizIcI3oc=";
        }
        {
          url = "https://cache.numtide.com";
          key = "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=";
        }
        {
          url = "https://cache.lantian.pub/lantian";
          key = "lantian:WVGO7vsRMSEN+h7Lp7kv6SAmrkEXgUGbbXm7jMDjBuQ=";
        }
      ];
      substituters = map (c: c.url) caches;
      trustedKeys = map (c: c.key) caches;
    };

    # Tailnet identity: MagicDNS suffix for serve URLs. Assigned by Tailscale and
    # stable unless the tailnet is renamed.
    tailnet = {
      suffix = "wampus-gamut.ts.net";
    };

    hosts = {
      gram = {
        pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIyaPm21KDiQAXbzoG0IS7KO8rwcrP2ZqwJjW6uvh29A wovw@gram";
        syncId = "STSZHNC-PHDMSOV-LLJUNMR-VZHVO5X-NERCW7A-OIEO36S-Y4YVMVK-H7FRKAP";
        unlocksPewter = true;
        isPersonalHost = true;
        hasDE = true;
      };
      harpe = {
        isPersonalHost = true;
      };
      warpe = {
        isWorkPc = true;
        usesWorkGit = true;
        isPersonalHost = true;
        pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJFlGnfX0uWipIXc1rpZap0ZxEdGTi4s+QhxriJ5bBcM mippbipp@warpe";
      };
      pewter = {
        sshPort = 2222; # set in oracle cloud security list ingress rules, used for luks unlocking
        luksHostname = "129.146.202.171";
        syncId = "POHLBBF-3AOYWFT-OK46SCB-Z4O4VHV-5NFB5MH-SX2OP5M-GNYZSTT-5VKEPQT";
        isExitNode = true;
        isServer = true;
        remoteBuilds = true;
        acceptsTailnetSsh = true;
        acceptsSsh = true;
        usesWorkGit = true;
        isPersonalHost = true;
      };
      brick = {
        external = true;
        syncId = "4Q75UQR-3BKJV5G-5DBCANF-FG5OUML-PMWS5XB-LUW2CSK-7RQX6AL-Y7KR4AI";
      };
    };
  };
}
