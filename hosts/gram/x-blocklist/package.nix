{
  lib,
  stdenvNoCC,
  nodejs_24,
  pnpm,
  fetchPnpmDeps,
  pnpmConfigHook,
}:
let
  # The pnpm workspace root; this package builds from there.
  root = ../../..;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "x-blocklist";
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
      (root + "/hosts/pewter/flake-updater/package.json")
      ./package.json
      ./tsconfig.json
      ./vitest.config.ts
      ./src
      ./test
      ./tools
    ];
  };

  pnpmWorkspaces = [ "x-blocklist" ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmWorkspaces
      ;
    inherit pnpm;
    fetcherVersion = 5;
    hash = "sha256-bcqrDhJhyXR8cxwjG2sC5oiHs0oW2JDKsbvgcFjTvg0=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
  ];

  buildPhase = ''
    runHook preBuild
    pnpm --filter x-blocklist run build
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    pnpm run prepare
    pnpm --filter x-blocklist run typecheck
    pnpm --filter x-blocklist run test
    pnpm exec oxfmt --check hosts/gram/x-blocklist
    pnpm exec oxlint hosts/gram/x-blocklist
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 hosts/gram/x-blocklist/dist/block.js $out/share/x-blocklist/block.js
    runHook postInstall
  '';

  meta.description = "The `browse execute` script that blocks an X list's members";
})
