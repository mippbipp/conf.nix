{
  lib,
  pkgs,
  host,
  globals,
  ...
}:
{
  programs.opencode = lib.mkIf (!globals.hosts.${host}.isWorkPc) {
    enable = true;
    package = pkgs.opencode;
    context = ''
      # Global

      Always use the "unslop" skill.

      ## What you need from me

      - End every turn where you're blocked on me, or where the next step needs me, with a short "**What I need from you**" section. Numbered, one concrete action per item: exactly what to do, where (which site, app, file or person), and what to send back. e.g. "Log into CommBank NetBank and export Jan to Jun 2026 as CSV, then drop it in `inbox/`", not "I need the bank data".
      - If there are several, put the quickest or most blocking one first, and say what you'll get on with in the meantime.
      - If you don't need anything from me, say "Nothing needed from you right now" so I don't have to ask.
      - Never bury a request for me in the middle of a long update.
    '';
    validateFiles = {
      config = true;
      cli = true;
    };
  };

  # OpenCode loads a directory in ~/.config/opencode/plugins as one plugin
  home.file.".config/opencode/plugins/kiro".source = pkgs.runCommand "opencode-kiro" { } ''
    mkdir $out
    cp ${./kiro/index.ts} $out/index.ts
    cp ${./kiro/tui.tsx} $out/tui.tsx
    cp ${./kiro/rpc.ts} $out/rpc.ts
  '';
}
