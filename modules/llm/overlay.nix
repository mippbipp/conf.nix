# Both opencode2 (V2 preview CLI) and the t3code override (currently on
# opencode V1 via providerPackages; swap to opencode2 when t3code supports
# it) resolve here.
#
{ inputs, lib, ... }:
{
  nixpkgs.overlays = [
    (
      final: prev:
      let
        llm = inputs.llm-agents.packages.${final.stdenv.hostPlatform.system};
        kiroPath = lib.makeBinPath [
          final.kiro-cli
          final.nodejs
        ];
      in
      {
        opencode2 = llm.opencode2.overrideAttrs (old: {
          # put opencode-kiro plugin's runtime dependencies on PATH
          postInstall = (old.postInstall or "") + ''
            wrapProgram $out/bin/opencode2 \
              --prefix PATH : ${kiroPath}
          '';
        });
        t3code = llm.t3code.override {
          providerPackages = with llm; [ opencode ];
        };
      }
    )
  ];
}
