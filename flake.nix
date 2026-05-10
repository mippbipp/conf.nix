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
      url = "github:nix-community/lanzaboote/v0.4.2";
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
    vicinae-extensions = {
      url = "github:vicinaehq/extensions";
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
    llm-agents.url = "github:numtide/llm-agents.nix";
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
      mkHostConfig =
        {
          host,
          username,
          nixosModules ? [ ],
          homeManagerModules ? [ ],
        }:
        nixpkgs.lib.nixosSystem {
          specialArgs = {
            inherit
              inputs
              username
              host
              ;
          };
          modules = [
            ./hosts/${host}/config.nix
            stylix.nixosModules.stylix
            nix-index-database.nixosModules.nix-index
            home-manager.nixosModules.home-manager
            (
              { pkgs, ... }:
              {
                home-manager = {
                  extraSpecialArgs = {
                    inherit
                      pkgs
                      username
                      inputs
                      host
                      ;
                  };
                  useGlobalPkgs = true;
                  useUserPackages = true;
                  backupFileExtension = "backup";
                  users.${username}.imports = [ ./hosts/${host}/home.nix ] ++ homeManagerModules;
                };
              }
            )
          ]
          ++ nixosModules;
        };
    in
    {
      nixosConfigurations = {
        gram = mkHostConfig {
          host = "gram";
          username = "mippbipp";
          nixosModules = [
            lanzaboote.nixosModules.lanzaboote
            (
              { pkgs, lib, ... }:
              {
                nixpkgs.overlays = [
                  inputs.oskars-dotfiles.overlays.spotx
                  inputs.nix-cachyos-kernel.overlays.pinned
                  inputs.rust-overlay.overlays.default
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
        harpe = mkHostConfig rec {
          host = "harpe";
          username = "mippbipp";
          nixosModules = [
            nixos-wsl.nixosModules.default
            {
              system.stateVersion = "24.05";
              wsl.enable = true;
              wsl.defaultUser = username;
            }
          ];
        };
      };
    };
}
