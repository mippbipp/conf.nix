{
  description = "NixOS";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    nix-cachyos-kernel.url = "github:xddxdd/nix-cachyos-kernel/release";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lanzaboote = {
      url = "github:nix-community/lanzaboote/v1.1.0";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.rust-overlay.follows = "rust-overlay";
    };
    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    stylix = {
      url = "github:nix-community/stylix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    caelestia-shell = {
      url = "github:mippbipp/shell/nexus-gpu";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    zen-browser = {
      url = "github:0xc000022070/zen-browser-flake/beta";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        home-manager.follows = "home-manager";
      };
    };
    oskars-dotfiles = {
      url = "github:oskardotglobal/.dotfiles/nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-wsl.url = "github:nix-community/NixOS-WSL/main";
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    winapps = {
      url = "github:winapps-org/winapps";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    vicinae.url = "github:vicinaehq/vicinae";
    xmcl = {
      url = "github:x45iq/xmcl-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    superfile = {
      url = "github:yorukot/superfile";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    herdr = {
      url = "github:herdrdev/herdr";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        rust-overlay.follows = "rust-overlay";
      };
    };
  };

  outputs =
    {
      nixpkgs,
      home-manager,
      nixos-wsl,
      stylix,
      nix-index-database,
      lanzaboote,
      ...
    }@inputs:
    let
      globals = import ./modules/globals.nix;
      mkHostConfig =
        {
          host,
          nixosModules ? [ ],
        }:
        nixpkgs.lib.nixosSystem {
          specialArgs = {
            # Raw globals (user, nextdns) only. Typed fleet records are
            # read from config.fleet.hosts; Home Manager gets the merged
            # records via extraSpecialArgs below.
            inherit
              inputs
              host
              globals
              ;
            username = globals.user.name;
          };
          modules = [
            ./modules/fleet.nix
            ./hosts/${host}/config.nix
            stylix.nixosModules.stylix
            nix-index-database.nixosModules.nix-index
            home-manager.nixosModules.home-manager
            (
              {
                pkgs,
                config,
                username,
                ...
              }:
              let
                # Typed fleet records merged under the existing arg name
                # for Home Manager consumers (devenv, ssh mesh, nrs).
                # NixOS modules read config.fleet.hosts directly.
                hmGlobals = {
                  inherit (globals) user nextdns;
                  hosts = config.fleet.hosts;
                };
              in
              {
                home-manager = {
                  extraSpecialArgs = {
                    inherit
                      pkgs
                      username
                      inputs
                      host
                      ;
                    globals = hmGlobals;
                    sopsSecrets = if config ? sops then config.sops.secrets else { };
                  };
                  useGlobalPkgs = true;
                  useUserPackages = true;
                  backupFileExtension = "backup";
                  users.${username}.imports = [ ./hosts/${host}/home.nix ];
                };

                nixpkgs.overlays = [
                  inputs.rust-overlay.overlays.default
                  (final: prev: {
                    t3code =
                      let
                        llm = inputs.llm-agents.packages.${final.stdenv.hostPlatform.system};
                      in
                      llm.t3code.override {
                        providerPackages = with llm; [ opencode ];
                      };
                  })

                ];
              }
            )
          ]
          ++ nixosModules;
        };
    nixosConfigurations = {
        gram = mkHostConfig {
          host = "gram";
          nixosModules = [
            lanzaboote.nixosModules.lanzaboote
            (
              { pkgs, lib, ... }:
              {
                nixpkgs.overlays = [
                  inputs.oskars-dotfiles.overlays.spotx
                  inputs.nix-cachyos-kernel.overlays.pinned
                ];

                environment.systemPackages = [
                  # For debugging and troubleshooting Secure Boot.
                  pkgs.sbctl
                ];

                # Lanzaboote currently replaces the systemd-boot module.
                # This setting is usually set to true in configuration.nix
                # generated at installation time. So we force it to false
                # for now.
                boot.loader.systemd-boot.enable = lib.mkForce false;

                boot.lanzaboote = {
                  enable = true;
                  pkiBundle = "/var/lib/sbctl";
                };
              }
            )
          ];
        };
        harpe = mkHostConfig {
          host = "harpe";
          nixosModules = [
            nixos-wsl.nixosModules.default
            (
              { username, ... }:
              {
                system.stateVersion = "24.05";
                wsl.enable = true;
                wsl.defaultUser = username;
              }
            )
          ];
        };
        warpe = mkHostConfig {
          host = "warpe";
          nixosModules = [
            nixos-wsl.nixosModules.default
            (
              { username, ... }:
              {
                system.stateVersion = "24.05";
                wsl.enable = true;
                wsl.defaultUser = username;
              }
            )
          ];
        };
        pewter = mkHostConfig {
          host = "pewter";
        };
        hector = mkHostConfig {
          host = "hector";
        };
      };
    in
    {
      inherit nixosConfigurations;

      checks =
        let
          systems = [
            "x86_64-linux"
            "aarch64-linux"
          ];
        in
        nixpkgs.lib.genAttrs systems (
          system:
          let
            pkgs = nixpkgs.legacyPackages.${system};
            profile = globals.nextdns.id;
            profHi = builtins.substring 0 2 profile;
            profLo = builtins.substring 2 4 profile;
            sentinel = "2a07:a8c0::${profHi}:${profLo}";
          in
          {
            # The Tailnet policy file is control-plane state outside this
            # flake's evaluation, so the NextDNS profile cannot be shared by
            # reference. Fail the gate instead when the two sides drift.
            # Patterns are quoted HCL strings so prose comments mentioning
            # the profile cannot satisfy them; the sentinel pins the full
            # NextDNS linked address (prefix is NextDNS address space).
            dns-profile-sync = pkgs.runCommand "dns-profile-sync" { } ''
              tf=${./terraform/tailscale/main.tf}
              grep -Fq '"nextdns:${profile}"' "$tf" || (echo "nodeAttrs profile mismatch: globals.nextdns.id ${profile} absent from Tailnet policy file" >&2; exit 1)
              grep -Fq '"${sentinel}"' "$tf" || (echo "sentinel mismatch: expected profile-linked IPv6 ${sentinel} in Tailnet policy file" >&2; exit 1)
              touch $out
            '';
            # Every NixOS host has a live fleet record and every live
            # record names a declared host. External peers (no NixOS
            # declaration) are exempt on the record side only.
            fleet-correspondence =
              let
                records = (nixpkgs.lib.evalModules { modules = [ ./modules/fleet.nix ]; }).config.fleet.hosts;
                declared = builtins.attrNames nixosConfigurations;
                missing = builtins.filter (h: !(records ? ${h}) || records.${h}.external) declared;
                liveRecords = nixpkgs.lib.filterAttrs (_: r: !r.external) records;
                phantom = builtins.filter (h: !(builtins.elem h declared)) (builtins.attrNames liveRecords);
              in
              if missing == [ ] && phantom == [ ] then
                pkgs.runCommand "fleet-correspondence" { } ''touch $out''
              else
                throw "fleet registry mismatch: missing records for ${builtins.toString missing}; phantom records for ${builtins.toString phantom}";
            # Locks in strictness: a typo'd Role flag and a mistyped flag
            # must both fail evaluation, so the registry can never silently
            # regress to `or false` semantics.
            fleet-strictness =
              let
                evalBad = extra: builtins.tryEval (builtins.deepSeq (nixpkgs.lib.evalModules {
                  modules = [ ./modules/fleet.nix { fleet.hosts.strictness-probe = extra; } ];
                }).config.fleet.hosts false);
              in
              if !(evalBad { isExitNod = true; }).success && !(evalBad { isExitNode = "yes"; }).success then
                pkgs.runCommand "fleet-strictness" { } ''touch $out''
              else
                throw "fleet registry is not strict: typo'd Role flag or wrong type evaluated successfully";
          }
        );
    };
}
