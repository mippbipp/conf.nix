# modified from https://github.com/bevyengine/bevy/blob/latest/docs/linux_dependencies.md#flakenix
{
  description = "bevy flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      rust-overlay,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };
        rustToolchain = pkgs.rust-bin.selectLatestNightlyWith (
          toolchain:
          toolchain.default.override {
            extensions = [
              "rust-src"
              "rust-analyzer"
              "rustc-codegen-cranelift-preview"
            ];
          }
        );
      in
      {
        devShells.default =
          with pkgs;
          mkShell {
            buildInputs = [
              rustToolchain
              pkg-config
              mold
              clang
            ]
            ++ lib.optionals (lib.strings.hasInfix "linux" system) [
              alsa-lib
              # Cross Platform 3D Graphics API
              vulkan-loader
              # For debugging around vulkan
              vulkan-tools
              # Other dependencies
              libudev-zero
              libX11
              libXcursor
              libXi
              libXrandr
              libxkbcommon
              wayland
            ];
            LD_LIBRARY_PATH = lib.makeLibraryPath [
              vulkan-loader
              libX11
              libXi
              libXcursor
              libxkbcommon

              # dynamic linking
              wayland
              udev
              alsa-lib
            ];
          };
      }
    );
}
