{
  description = "tauri flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
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
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [
            "rust-src"
            "rust-analyzer"
          ];
        };
      in
      {
        devShells.default =
          with pkgs;
          mkShell {
            # https://wiki.nixos.org/wiki/Tauri
            nativeBuildInputs = [
              nodejs_25
              pnpm
              rustToolchain
              pkg-config
              gobject-introspection
            ];

            buildInputs = [
              at-spi2-atk
              atkmm
              cairo
              gdk-pixbuf
              glib
              gtk3
              harfbuzz
              librsvg
              libsoup_3
              pango
              webkitgtk_4_1
              openssl
              zlib
              desktop-file-utils # `update-desktop-database` for tauri-plugin-deep-link
            ];

            # env vars
            GIO_MODULE_DIR = "${pkgs.glib-networking}/lib/gio/modules/"; # https://github.com/tauri-apps/tauri/issues/11647

            shellHook = ''
              # Expose GTK schemas to the runtime environment. Makes FileChooser schema available in Tauri app to open / select through files app.
              export XDG_DATA_DIRS="${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS";
            '';
          };
      }
    );
}
