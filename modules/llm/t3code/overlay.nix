{ inputs, lib, ... }:
{
  nixpkgs.overlays = [
    (
      final: prev:
      let
        llm = inputs.llm-agents.packages.${final.stdenv.hostPlatform.system};
        chrome-headless-shell = final.callPackage ./chrome-headless-shell.nix { };
        chromeExe = "${chrome-headless-shell}/${chrome-headless-shell.passthru.executable}";
      in
      {
        t3code = llm.t3code.override {
          providerPackages = [ final.opencode ];
          # T3 otherwise downloads an unpatched chrome-headless-shell into
          # ~/.t3/tools, which can't find its libraries on NixOS
          t3code-unwrapped = llm.t3code.unwrapped.overrideAttrs (
            old:
            lib.optionalAttrs final.stdenv.hostPlatform.isLinux {
              postPatch = old.postPatch + ''
                pinned=$(sed -n 's/^const VERSION = "\(.*\)";/\1/p' apps/server/src/preview/PreviewBrowser.ts)
                if [[ "$pinned" != "${chrome-headless-shell.version}" ]]; then
                  echo "error: upstream pins chrome-headless-shell $pinned, update modules/llm/t3code/chrome-headless-shell.nix" >&2
                  exit 1
                fi
                substituteInPlace apps/server/src/preview/PreviewBrowser.ts \
                  --replace-fail \
                    "return yield* makePreviewBrowser({ baseDir: config.baseDir });" \
                    "void config; return PreviewBrowser.of({ executable: Effect.succeed(\"${chromeExe}\"), installed: Effect.succeedSome(\"${chromeExe}\") });"
              '';
            }
          );
        };
      }
    )
  ];
}
