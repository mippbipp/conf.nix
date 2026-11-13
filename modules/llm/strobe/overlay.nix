_: {
  # strobe's deep probes read native stacks with perf events. Kernel frames
  # need perf_event_paranoid 1 or lower (NixOS defaults to 2).
  boot.kernel.sysctl."kernel.perf_event_paranoid" = 1;

  nixpkgs.overlays = [
    (final: _: {
      # strobe (anomalyco/strobe), from npm. Each @hona/strobe-<platform>
      # package is one statically linked binary, so no bun or patchelf.
      strobe =
        let
          version = "0.36.0";
          arch =
            {
              x86_64-linux = {
                name = "x64";
                hash = "sha512-q/brYo1wrqij/rtCMKjK3gVpknncCsulZ+DjrFdW+5dh/cBbWRnuJKV1c3BEYQmXI+/puesqTktV5d3xGlXTpg==";
              };
              aarch64-linux = {
                name = "arm64";
                hash = "sha512-SJxTyskt5iCfklNVbRnCxL5jyjtspiV54T8eI+B6Y+qJJ9dk2FGlP/y/YfSkZF1w1N+v1rdKComfZatO5nkpSw==";
              };
            }
            .${final.stdenv.hostPlatform.system};
        in
        final.stdenvNoCC.mkDerivation {
          pname = "strobe";
          inherit version;
          src = final.fetchurl {
            url = "https://registry.npmjs.org/@hona/strobe-linux-${arch.name}/-/strobe-linux-${arch.name}-${version}.tgz";
            inherit (arch) hash;
          };
          sourceRoot = "package";
          dontStrip = true;
          installPhase = ''
            install -Dm755 strobe $out/bin/strobe
          '';
          meta = {
            description = "Measure and explain performance";
            homepage = "https://github.com/anomalyco/strobe";
            mainProgram = "strobe";
            platforms = [
              "x86_64-linux"
              "aarch64-linux"
            ];
          };
        };
    })
  ];
}
