{
  lib,
  pkgs,
  host,
  globals,
  ...
}:
let
  hostRecord = globals.hosts.${host};
in
{
  programs.opencode = lib.mkIf (!hostRecord.isWorkPc) {
    enable = true;
    settings = {
      compaction = {
        buffer = "45%";
        keep.tokens = 20000;
      };
      tool_output = {
        max_lines = 500;
        max_bytes = 20480;
      };
    }
    // lib.optionalAttrs (hostRecord.hasDE || hostRecord.isServer) {
      mcp.servers.browse = {
        type = "local";
        command = [
          (lib.getExe pkgs.opencode-browse)
          "mcp"
        ];
      };
    };
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

  home.file.".config/opencode/plugins/kiro".source = ./kiro/src;
}
