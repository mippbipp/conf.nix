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

            # llm-agents installs the v2 binary as `opencode2`
            ln -s opencode2 $out/bin/opencode
          '';
        });
        t3code = llm.t3code.override {
          providerPackages = [ final.opencode2 ];
        };
      }
    )
  ];
}
