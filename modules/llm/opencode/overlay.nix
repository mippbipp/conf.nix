{ lib, ... }:
{
  nixpkgs.overlays = [
    (final: prev: {
      # kiro-cli on opencode's PATH, so the Kiro plugin can have it refresh its
      # sign-in.
      opencode = final.symlinkJoin {
        name = "opencode-${prev.opencode.version}";
        paths = [ prev.opencode ];
        nativeBuildInputs = [ final.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/opencode \
            --prefix PATH : ${lib.makeBinPath [ final.kiro-cli ]}
        '';
        inherit (prev.opencode) meta passthru;
      };
    })
  ];
}
