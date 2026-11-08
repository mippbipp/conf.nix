{
  lib,
  stdenvNoCC,
  nodejs_24,
  pnpm,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  coreutils,
  gh,
  git,
  gnutar,
  nix,
}:
let
  # The pnpm workspace root; this package builds from there.
  root = ../../..;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "flake-updater";
  version = "0.0.0";

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/tsconfig.base.json")
      (root + "/oxlint.config.ts")
      (root + "/oxfmt.config.ts")
      (root + "/tools/oxlint")
      # pnpm resolves every workspace package, so the others' manifests must
      # be present even though only this one is installed.
      (root + "/hosts/gram/x-blocklist/package.json")
      ./package.json
      ./blocked-paths.json
      ./tsconfig.json
      ./vitest.config.ts
      ./src
      ./test
    ];
  };

  pnpmWorkspaces = [ "flake-updater" ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 5;
    hash = "sha256-KJn2BjqUua4G0//NwwoJBHkhwDUsYvux5MQdDdJc+Q0=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  # Node runs the TypeScript sources directly; there is nothing to compile.
  dontBuild = true;

  # test/git.test.ts drives the checkout adapter against real git.
  nativeCheckInputs = [ git ];

  # The Build gate builds pewter's closure, which includes this package, so
  # these checks gate every change to the Updater.
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    pnpm run prepare
    pnpm --filter flake-updater run typecheck
    pnpm --filter flake-updater run test
    pnpm exec oxfmt --check hosts/pewter/flake-updater
    pnpm exec oxlint hosts/pewter/flake-updater
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    # A self-contained copy of the package with only its production
    # dependencies, installed offline from the hook's store.
    pnpm --filter flake-updater deploy --prod --offline --ignore-scripts deploy
    mkdir -p $out/lib $out/bin
    cp -r deploy $out/lib/flake-updater
    makeWrapper ${lib.getExe nodejs_24} $out/bin/flake-updater \
      --add-flags $out/lib/flake-updater/src/main.ts \
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
})
