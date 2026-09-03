{
  pkgs,
  username,
  config,
  ...
}:

let
  common = import ./flake-pipeline-common.nix {
    githubTokenPath = config.sops.secrets.github_token.path;
  };
  updater = pkgs.writeShellApplication {
    name = "flake-updater";
    runtimeInputs = with pkgs; [
      coreutils
      git
      gh
      nix
    ];
    text = ''
      repo_dir="/var/lib/flake-updater"
      dry_run=false
      while [ $# -gt 0 ]; do
          case "$1" in
              --repo-dir) repo_dir="$2"; shift 2 ;;
              --dry-run) dry_run=true; shift ;;
              *) echo "usage: flake-updater [--repo-dir DIR] [--dry-run]" >&2; exit 2 ;;
          esac
      done

      ${common.exportAuth}
      # Keep gh's push credential helper out of the Home Manager-managed config.
      export GIT_CONFIG_GLOBAL="$repo_dir/.gitconfig"
      gh auth setup-git --hostname github.com
      git -C "$repo_dir" config user.name "mippbipp"
      git -C "$repo_dir" config user.email "mippbipp@users.noreply.github.com"

      cd "$repo_dir"
      git -c fetch.recurseSubmodules=false fetch --prune origin main
      git checkout -B flake-update origin/main
      git reset --hard origin/main
      git fetch origin flake-update 2>/dev/null || true
      if git show-ref --verify --quiet refs/remotes/origin/flake-update; then
          git reset --hard origin/flake-update
          git rebase origin/main
      fi
      nix flake update
      if git diff --quiet -- flake.lock; then
          echo "flake.lock is already current"
          exit 0
      fi

      if [ "$dry_run" = true ]; then
          git diff -- flake.lock
          echo "dry-run: would push flake-update and create/update its PR"
          exit 0
      fi
      git add flake.lock
      git commit -m "up"
      git push --force-with-lease origin HEAD:flake-update

      pr="$(gh pr list --repo "$GH_REPO" --state open --head flake-update --json number --jq '.[0].number // empty')"
      if [ -z "$pr" ]; then
          gh pr create --repo "$GH_REPO" --base main --head flake-update \
              --title "up" --body "Automated flake input update." \
              --label dependencies --label automated
          pr="$(gh pr list --repo "$GH_REPO" --state open --head flake-update --json number --jq '.[0].number')"
      fi
      # Auto-merge is requested here, but GitHub still waits for every required gate check.
      gh pr merge "$pr" --repo "$GH_REPO" --auto --rebase
    '';
  };
in
{
  environment.systemPackages = [
    updater
  ];
  systemd = {
    services.flake-updater = {
      description = "Bump flake inputs and maintain the verified update PR";
      serviceConfig = {
        Type = "oneshot";
        User = username;
        StateDirectory = "flake-updater";
        ExecStart = "${updater}/bin/flake-updater";
      };
    };
    timers.flake-updater = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "Mon *-*-* 02:00:00";
        Persistent = true;
        RandomizedDelaySec = "30m";
      };
    };
  };
}
