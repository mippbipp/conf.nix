{
  lib,
  buildNpmPackage,
  importNpmLock,
  makeWrapper,
  nodejs,
  pkgs,
  inputs,
}:
let
  src = ./app;
  npmDeps = importNpmLock { npmRoot = src; };

  cli = buildNpmPackage {
    pname = "dgpu";
    version = "1.0.0";

    inherit src npmDeps;

    npmConfigHook = importNpmLock.npmConfigHook;
    npmBuildScript = "build:cli";

    nativeBuildInputs = [ makeWrapper ];

    doCheck = true;
    checkPhase = ''
      runHook preCheck
      npm test
      runHook postCheck
    '';

    installPhase = ''
      runHook preInstall
      install -Dm644 dist/cli.mjs $out/lib/dgpu/cli.mjs
      makeWrapper ${nodejs}/bin/node $out/bin/dgpu \
        --add-flags $out/lib/dgpu/cli.mjs
      runHook postInstall
    '';

    meta = {
      description = "Create and reconcile per-app dGPU wrapper desktop entries";
      license = lib.licenses.mit;
      mainProgram = "dgpu";
      platforms = lib.platforms.linux;
    };
  };

  extension = inputs.vicinae.lib.${pkgs.stdenv.hostPlatform.system}.mkVicinaeExtension {
    name = "dgpu";
    version = "1.0.0";
    inherit src;
  };
in
{
  inherit cli extension;
}
