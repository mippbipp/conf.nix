{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:
let
  stateDir = "${config.xdg.stateHome}/x-blocklist";
  # The Effect program in src/. It drives Chrome through the browse CLI.
  package = pkgs.callPackage ./package.nix {
    bun2nix = inputs.bun2nix.packages.${pkgs.stdenv.hostPlatform.system}.default;
  };
  run = pkgs.writeShellApplication {
    name = "x-blocklist-run";
    runtimeInputs = [
      package
      pkgs.opencode-browse
      pkgs.coreutils
      pkgs.jq
      pkgs.procps
      pkgs.google-chrome
    ];
    text = ''
      mkdir -p ${lib.escapeShellArg stateDir}

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
        browse status --json | jq -e .connected >/dev/null 2>&1 && break
        sleep 3
      done

      out=$(x-blocklist)
      jq -c '.actions[] + {at: (now | todate)}' <<<"$out" >>${lib.escapeShellArg "${stateDir}/actions.jsonl"}
      jq 'del(.actions)' <<<"$out"
      jq -e '.stoppedAt == null' <<<"$out" >/dev/null
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
