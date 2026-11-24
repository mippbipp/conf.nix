{
  lib,
  stdenv,
  stdenvNoCC,
  autoPatchelfHook,
  bun2nix,
}:
let
  # The Bun workspace root; this package builds from there.
  root = ../../../..;
in
stdenvNoCC.mkDerivation {
  pname = "opencode-kiro";
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
      (root + "/hosts/gram/x-blocklist/package.json")
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
      import ../../../../bun.nix (args // { copyPathToStore = _: null; });
  };

  nativeBuildInputs = [ bun2nix.hook ];

  # The root `postinstall` would run bun2nix; checkPhase runs `prepare`.
  dontRunLifecycleScripts = true;

  # OpenCode loads src/ as it is, so there is nothing to build.
  dontBuild = true;

  nativeCheckInputs = [ autoPatchelfHook ];
  checkInputs = [ stdenv.cc.cc.lib ];

  # Home Manager installs this package's output as the plugin, so these
  # checks gate every change to it. `bun --bun` runs every
  # `#!/usr/bin/env node` script with Bun, so the checks need no Node.js.
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    bun --bun run prepare
    # The patched oxlint runs tsrs for type-aware rules; its npm binary
    # expects an FHS dynamic loader the sandbox doesn't have.
    chmod -R u+w node_modules/.bun/@tsrs+*/node_modules/@tsrs
    autoPatchelf node_modules/.bun/@tsrs+*/node_modules/@tsrs
    bun --bun run --cwd modules/llm/opencode/kiro typecheck
    bun --bun run --cwd modules/llm/opencode/kiro test
    bun --bun x oxfmt --check modules/llm/opencode/kiro
    bun --bun x oxlint modules/llm/opencode/kiro
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    cp -r modules/llm/opencode/kiro/src $out
    runHook postInstall
  '';

  meta.description = "OpenCode plugin for Kiro's Claude models, checked before Home Manager installs it";
}
