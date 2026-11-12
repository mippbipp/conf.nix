{
  lib,
  stdenvNoCC,
  bun2nix,
  bun,
  makeWrapper,
  coreutils,
  gh,
  git,
  gnutar,
  nix,
}:
let
  # The Bun workspace root; this package builds from there.
  root = ../../..;
in
stdenvNoCC.mkDerivation {
  pname = "flake-updater";
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
      (root + "/hosts/gram/x-blocklist/package.json")
      ./package.json
      ./blocked-paths.json
      ./tsconfig.json
      ./vitest.config.ts
      ./src
      ./test
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

  nativeBuildInputs = [
    bun2nix.hook
    makeWrapper
  ];

  # The root `postinstall` would run bun2nix; checkPhase runs `prepare`.
  dontRunLifecycleScripts = true;

  # One file with every dependency inlined, so the output needs no
  # node_modules.
  buildPhase = ''
    runHook preBuild
    bun build hosts/pewter/flake-updater/src/main.ts \
      --target=bun \
      --outfile=dist/flake-updater.js
    runHook postBuild
  '';

  # test/git.test.ts drives the checkout adapter against real git.
  nativeCheckInputs = [ git ];

  # The Build gate builds pewter's closure, which includes this package, so
  # these checks gate every change to the Updater. `bun --bun` runs every
  # `#!/usr/bin/env node` script with Bun, so the checks need no Node.js.
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    bun --bun run prepare
    bun --bun run --cwd hosts/pewter/flake-updater typecheck
    bun --bun run --cwd hosts/pewter/flake-updater test
    bun --bun x oxfmt --check hosts/pewter/flake-updater
    bun --bun x oxlint hosts/pewter/flake-updater
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 dist/flake-updater.js $out/lib/flake-updater/flake-updater.js
    # Bun would otherwise read a bunfig.toml and a .env from the working
    # directory. The Flake fixer runs `flake-updater revert-lock` in a
    # workspace it can edit, so a bunfig `preload` there would run its code.
    makeWrapper ${lib.getExe bun} $out/bin/flake-updater \
      --add-flags "--config=/dev/null --no-env-file $out/lib/flake-updater/flake-updater.js" \
      --prefix PATH : ${
        lib.makeBinPath [
          coreutils
          gh
          git
          gnutar
          nix
        ]
      }
    runHook postInstall
  '';

  meta = {
    description = "Bump flake inputs, wait for the Build gate, and repair failed updates";
    mainProgram = "flake-updater";
  };
}
