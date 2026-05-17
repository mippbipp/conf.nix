{
  description = "Python";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
      };
      pythonVersion = "3.14";
    in
    {
      devShells."${system}".default = pkgs.mkShell {
        NIX_LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
          pkgs.stdenv.cc.cc.lib
          pkgs.zlib # libz.so.1
          pkgs.glib # Often required by pandas/matplotlib
          pkgs.libGL # Required by matplotlib
          pkgs.libxkbcommon # Often required for plotting backends
        ];
        NIX_LD = pkgs.lib.fileContents "${pkgs.stdenv.cc}/nix-support/dynamic-linker";

        packages = with pkgs; [
          uv
        ];

        shellHook = ''
          # Idempotent init
          if [ ! -f pyproject.toml ]; then
            echo "🚀 Bootstrapping new uv project with Python ${pythonVersion}..."
            uv init --python ${pythonVersion} --no-workspace
          fi

          uv sync
          source .venv/bin/activate
        '';
      };
    };
}
