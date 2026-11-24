{
  lib,
  pkgs,
  config,
  host,
  globals,
  inputs,
  ...
}:
let
  hostRecord = globals.hosts.${host};
  # The plugin's src/, once its typecheck, tests and lint pass.
  kiro = pkgs.callPackage ./kiro/package.nix {
    bun2nix = inputs.bun2nix.packages.${pkgs.stdenv.hostPlatform.system}.default;
  };
in
{
  programs.opencode = lib.mkIf (!hostRecord.isWorkPc) {
    enable = true;
    settings = {
      model = "kiro/claude-opus-5.5#medium";
      skills = [ "~/.agents/pstack/skills" ];
      # pstack opens playbook steps as todos and nests subagents (Feature -> arena, interrogate reviewers).
      experimental = {
        todo = true;
        subagent_depth = 2;
      };
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
  # when the plugin directory's symlink points somewhere new, opencode drops
  # the running kiro provider until it restarts.
  home.activation.restartOpencodeForKiro = lib.mkIf (!hostRecord.isWorkPc) (
    lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      old=""
      if [[ -n "''${oldGenPath:-}" ]]; then
        old="$(readlink -f "$oldGenPath/home-files/.config/opencode/plugins/kiro" || true)"
      fi
      if [[ "$old" != "${kiro}" ]]; then
        run ${pkgs.coreutils}/bin/timeout 30 \
          ${lib.getExe config.programs.opencode.package} service stop \
          || warnEcho "Couldn't stop the OpenCode server; restart it to load the new Kiro plugin."
      fi
    ''
  );
  home = {
    file = {
      ".config/opencode/plugins/kiro".source = kiro;
      ".config/opencode/commands".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/conf.nix/modules/llm/.agents/pstack/opencode/commands";
      ".config/opencode/agents".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/conf.nix/modules/llm/.agents/pstack/opencode/agents";
      ".config/opencode/pstack-models.md".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/conf.nix/modules/llm/.agents/pstack/src/pstack-models.md";
    };
  };
}
