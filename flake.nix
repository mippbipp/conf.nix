{
  description = "NixOS";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    nix-cachyos-kernel = {
      url = "github:xddxdd/nix-cachyos-kernel/release";
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
    # nix-community/bun2nix#110: bun2nix 2.1.2 rejects the lockfileVersion 2
    # that bun 1.4 writes. Move back to nix-community/bun2nix once it merges.
    bun2nix = {
      url = "github:Mic92/bun2nix/0456acb1b7394fc14c414b056aa889df5124943a";
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
                    sopsTemplates = if config ? sops then config.sops.templates else { };
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
      nixosConfigurations = nixpkgs.lib.genAttrs [
        "gram"
        "harpe"
        "warpe"
        "pewter"
      ] (host: mkHostConfig { inherit host; });
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
        # bun.nix is generated by bun2nix; formatting it would fight the
        # postinstall output.
        nixpkgs.lib.genAttrs systems (
          system:
          nixpkgs.legacyPackages.${system}.nixfmt-tree.override {
            settings.global.excludes = [ "bun.nix" ];
          }
        );

      # Bun and bun2nix for the TypeScript workspace. With bun2nix on PATH,
      # `bun install` regenerates bun.nix through the root postinstall.
      devShells = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              inputs.bun2nix.packages.${system}.default
            ];
          };
        }
      );
    };
}
