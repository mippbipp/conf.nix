{
  lib,
  stdenvNoCC,
  bun2nix,
}:
let
  # The Bun workspace root; this package builds from there.
  root = ../../..;
in
stdenvNoCC.mkDerivation {
  pname = "x-blocklist";
  version = "0.0.0";

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/bun.lock")
      (root + "/bunfig.toml")
      (root + "/tsconfig.base.json")
      (root + "/oxlint.config.ts")
      (root + "/oxfmt.config.ts")
      (root + "/tools/oxlint")
      # bun reads every workspace manifest, so the others must be present
      # even though only this one is built.
      (root + "/hosts/pewter/flake-updater/package.json")
      ./package.json
      ./tsconfig.json
      ./vitest.config.ts
      ./src
      ./test
      ./tools
    ];
  };

  bunDeps = bun2nix.fetchBunDeps {
    # bun.nix copies every workspace package into the dependency set, so an
    # edit to one package would rebuild the others. Bun links workspace
    # packages from the source tree, so drop them: fetchBunDeps keeps only
    # entries that are store paths.
    bunNix =
      {
        fetchurl,
        fetchFromGitHub,
        fetchgit,
      }@args:
      import ../../../bun.nix (args // { copyPathToStore = _: null; });
  };

  nativeBuildInputs = [ bun2nix.hook ];

  # The root `postinstall` would run bun2nix; checkPhase runs `prepare`.
  dontRunLifecycleScripts = true;

  # `bun --bun` runs every `#!/usr/bin/env node` script with Bun, so the
  # build needs no Node.js.
  buildPhase = ''
    runHook preBuild
    bun --bun run --cwd hosts/gram/x-blocklist build
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    bun --bun run prepare
    bun --bun run --cwd hosts/gram/x-blocklist typecheck
    bun --bun run --cwd hosts/gram/x-blocklist test
    bun --bun x oxfmt --check hosts/gram/x-blocklist
    bun --bun x oxlint hosts/gram/x-blocklist
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 hosts/gram/x-blocklist/dist/block.js $out/share/x-blocklist/block.js
    runHook postInstall
  '';

  meta.description = "The `browse execute` script that blocks an X list's members";
}
