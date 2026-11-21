{
  lib,
  stdenv,
  stdenvNoCC,
  autoPatchelfHook,
  bun2nix,
  bun,
  makeWrapper,
  opencode-browse,
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
      # bun reads every workspace manifest, so the others must be present
      # even though only this one is built.
      (root + "/hosts/pewter/flake-updater/package.json")
      ./package.json
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
    bun build hosts/gram/x-blocklist/src/main.ts \
      --target=bun \
      --outfile=dist/x-blocklist.js
    runHook postBuild
  '';

  nativeCheckInputs = [ autoPatchelfHook ];
  checkInputs = [ stdenv.cc.cc.lib ];

  # `bun --bun` runs every `#!/usr/bin/env node` script with Bun, so the
  # checks need no Node.js.
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    bun --bun run prepare
    # The patched oxlint runs tsrs for type-aware rules; its npm binary
    # expects an FHS dynamic loader the sandbox doesn't have.
    chmod -R u+w node_modules/.bun/@tsrs+*/node_modules/@tsrs
    autoPatchelf node_modules/.bun/@tsrs+*/node_modules/@tsrs
    bun --bun run --cwd hosts/gram/x-blocklist typecheck
    bun --bun run --cwd hosts/gram/x-blocklist test
    bun --bun x oxfmt --check hosts/gram/x-blocklist
    bun --bun x oxlint hosts/gram/x-blocklist
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 dist/x-blocklist.js $out/lib/x-blocklist/x-blocklist.js
    # Bun would otherwise read a bunfig.toml and a .env from the working
    # directory.
    makeWrapper ${lib.getExe bun} $out/bin/x-blocklist \
      --add-flags "--config=/dev/null --no-env-file $out/lib/x-blocklist/x-blocklist.js" \
      --prefix PATH : ${lib.makeBinPath [ opencode-browse ]}
    runHook postInstall
  '';

  meta = {
    description = "Sync the X account's blocks to Clankwall's AI-flagged accounts";
    mainProgram = "x-blocklist";
  };
}
