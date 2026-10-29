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
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "flake-updater";
  version = "0.0.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./blocked-paths.json
      ./pnpm-lock.yaml
      ./pnpm-workspace.yaml
      ./tsconfig.json
      ./oxlint.config.ts
      ./oxfmt.config.ts
      ./vitest.config.ts
      ./src
      ./test
      ./tools
    ];
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 5;
    hash = "sha256-v75xjetYmKBU7uCJGzcFUhcBEHzDHr6sas2fvHAIC+U=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  # Node runs the TypeScript sources directly; there is nothing to compile.
  dontBuild = true;

  # The Build gate builds pewter's closure, which includes this package, so
  # these checks gate every change to the Updater.
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    pnpm run prepare
    pnpm run typecheck
    pnpm run test
    pnpm run format
    pnpm run lint
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    # `pnpm prune` re-verifies the lockfile over the network, and installing
    # over the dev tree leaves its packages in node_modules/.pnpm. A clean
    # offline install from the hook's store keeps only production packages.
    rm -rf node_modules
    pnpm install --offline --prod --ignore-scripts --frozen-lockfile
    mkdir -p $out/lib/flake-updater $out/bin
    cp -r package.json blocked-paths.json src node_modules $out/lib/flake-updater/
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
