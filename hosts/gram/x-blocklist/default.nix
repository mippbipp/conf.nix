{
  pkgs,
  lib,
  config,
  ...
}:
let
  stateDir = "${config.xdg.stateHome}/x-blocklist";
  # The Effect program in src/, bundled into one `browse execute` script.
  script = "${pkgs.callPackage ./package.nix { }}/share/x-blocklist/block.js";
  run = pkgs.writeShellApplication {
    name = "x-blocklist";
    runtimeInputs = [
      pkgs.nodejs
      pkgs.bash
      pkgs.coreutils
      pkgs.jq
      pkgs.procps
      pkgs.google-chrome
    ];
    text = ''
      mkdir -p ${lib.escapeShellArg stateDir}
      browse() { npx -y @opencode/browse@0.0.14 "$@"; }

      # Start Chrome if it isn't running, and quit it afterwards. A Chrome
      # you already had open is left alone. It needs a window: with
      # --no-startup-window the browse extension never connects.
      chrome_pid=""
      if ! pgrep -u "$UID" -f '/google/chrome/chrome( |$)' >/dev/null; then
        google-chrome-stable --new-window about:blank >/dev/null 2>&1 &
        chrome_pid=$!
        trap 'kill "$chrome_pid" 2>/dev/null; wait "$chrome_pid" 2>/dev/null || true' EXIT
      fi

      for _ in $(seq 30); do
        browse execute --rm --timeout-ms 10000 'return 1' >/dev/null 2>&1 && break
        sleep 3
      done

      # A first sync or a big Clankwall change can mean hundreds of requests
      # at ~5.5s each; a normal day is a handful.
      out=$(browse execute --rm --json --timeout-ms 10800000 --file ${script})
      jq -c '.value.actions[]? + {at: (now | todate)}' <<<"$out" >>${lib.escapeShellArg "${stateDir}/actions.jsonl"}
      jq '.value | del(.actions)' <<<"$out"
      jq -e '.ok and .value.stoppedAt == null' <<<"$out" >/dev/null
    '';
  };
in
{
  # Keeps the X account's blocked list equal to Clankwall's AI-flagged
  # accounts, through the logged-in Chrome on this host and the browse
  # extension. When Chrome isn't running it opens a Chrome
  # window for the run. That needs the graphical session, so a run before
  # login fails and retries hourly.
  systemd.user.services.x-blocklist = {
    Unit = {
      Description = "Sync X blocks to Clankwall's AI-flagged accounts";
      StartLimitIntervalSec = "1d";
      StartLimitBurst = 12;
    };
    Service = {
      Type = "oneshot";
      ExecStart = lib.getExe run;
      Environment = [ "OPENCODE_BROWSER_AUTO_UPDATE=off" ];
      Restart = "on-failure";
      RestartSec = "1h";
    };
  };

  systemd.user.timers.x-blocklist = {
    Unit.Description = "Daily Clankwall block sync";
    Timer = {
      OnCalendar = "*-*-* 18:00:00";
      RandomizedDelaySec = "30m";
      # Run on the next wake or login if the laptop was off or asleep.
      Persistent = true;
    };
    Install.WantedBy = [ "timers.target" ];
  };
}
