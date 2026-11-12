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

      # The one pin for @opencode/browse, used by the MCP server and x-blocklist.
      opencode-browse = final.writeShellApplication {
        name = "browse";
        runtimeInputs = [
          final.nodejs
          final.bash
          final.coreutils
        ];
        # Its self-updater runs `npm install -g`, which can't write to the Nix store.
        runtimeEnv.OPENCODE_BROWSER_AUTO_UPDATE = "off";
        text = ''exec npx -y @opencode/browse@0.0.14 "$@"'';
      };
    })
  ];
}
