{
  description = "NixOS";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    nix-cachyos-kernel = {
      url = "github:xddxdd/nix-cachyos-kernel/release";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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
      url = "github:caelestia-dots/shell";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    zen-browser = {
      url = "github:0xc000022070/zen-browser-flake/beta";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        home-manager.follows = "home-manager";
      };
    };
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL/main";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    winapps = {
      url = "github:winapps-org/winapps";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    vicinae = {
      url = "github:vicinaehq/vicinae";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    vicinae-dgpu = {
      url = "github:mippbipp/vicinae-dgpu";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    xmcl = {
      url = "github:x45iq/xmcl-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    superfile = {
      url = "github:mippbipp/superfile/recursive-search";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    herdr = {
      url = "github:herdrdev/herdr";
      inputs.rust-overlay.follows = "rust-overlay";
    };
    axonometric.url = "github:mippbipp/axonometric";
    hex = {
      url = "github:anomalyco/hex";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        home-manager.follows = "home-manager";
      };
    };
    omasnap = {
      url = "github:vsgoulart/omasnap-flake";
      inputs.nixpkgs.follows = "nixpkgs";
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
        }:
        nixpkgs.lib.nixosSystem {
          specialArgs = {
            # Raw globals (user, nextdns, cache) only. Typed fleet records are
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
            ./modules/fleet/system.nix
            ./modules/llm/overlay.nix
            ./hosts/${host}/config.nix
            stylix.nixosModules.stylix
            nix-index-database.nixosModules.default
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
                  inherit (globals) user nextdns cache;
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
                  users.${username} = {
                    imports = [
                      ./hosts/${host}/home.nix
                      ./modules/fleet/hm.nix
                    ];
                  };
                };

                nixpkgs.overlays = [
                  inputs.rust-overlay.overlays.default
                ];
              }
            )
          ];
        };
      nixosConfigurations = {
        gram = mkHostConfig {
          host = "gram";
        };
        harpe = mkHostConfig {
          host = "harpe";
        };
        warpe = mkHostConfig {
          host = "warpe";
        };
        pewter = mkHostConfig {
          host = "pewter";
        };
      };
    in
    {
      inherit nixosConfigurations;

      checks = import ./checks.nix {
        inherit nixpkgs nixosConfigurations globals;
      };

      formatter =
        let
          systems = nixpkgs.lib.unique (
            nixpkgs.lib.mapAttrsToList (_: cfg: cfg.config.nixpkgs.hostPlatform.system) nixosConfigurations
          );
        in
        nixpkgs.lib.genAttrs systems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);
    };
}
