{
  pkgs,
  username,
  config,
  ...
}:

let
  repo = "mippbipp/conf.nix";
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

      github_token="$(< ${config.sops.secrets.github_token.path})"
      export GH_TOKEN="$github_token"
      export GH_REPO="''${GH_REPO:-${repo}}"
      gh auth setup-git --hostname github.com
      mkdir -p "$repo_dir"
      if [ ! -d "$repo_dir/.git" ]; then
          git clone "https://github.com/$GH_REPO.git" "$repo_dir"
      fi

      cd "$repo_dir"
      git fetch --prune origin main
      git checkout -B flake-update origin/main
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

  deployer = pkgs.writeShellApplication {
    name = "flake-deployer";
    runtimeInputs = with pkgs; [
      coreutils
      curl
      git
      gh
      nixos-rebuild
      tailscale
      systemd
    ];
    text = ''
      repo_dir="/var/lib/flake-deployer"
      if [ "''${1:-}" = "--repo-dir" ]; then repo_dir="$2"; fi
      github_token="$(< ${config.sops.secrets.github_token.path})"
      export GH_TOKEN="$github_token"
      export GH_REPO="''${GH_REPO:-${repo}}"
      mkdir -p "$repo_dir"
      if [ ! -d "$repo_dir/.git" ]; then
          git clone "https://github.com/$GH_REPO.git" "$repo_dir"
      fi
      cd "$repo_dir"
      git fetch --prune origin main
      git checkout -B main origin/main
      git submodule update --init --recursive

      commit="$(git rev-parse HEAD)"
      for check in "build gram" "build harpe" "build warpe" "build pewter"; do
          conclusion="$(gh api "repos/$GH_REPO/commits/$commit/check-runs" --jq "[.check_runs[] | select(.name == \"$check\")][0].conclusion // empty" || true)"
          if [ "$conclusion" != success ]; then
              echo "required Build gate check is not successful: $check ($conclusion)" >&2
              exit 1
          fi
      done

      previous="$(readlink -f /run/current-system)"
      if ! sudo nixos-rebuild switch --flake ".?submodules=1#pewter"; then
          sudo "$previous/bin/switch-to-configuration" switch || true
          exit 1
      fi

      tailscale_state=failed
      t3code_state="$(systemctl is-active t3code.service || true)"
      sshd_state="$(systemctl is-active sshd.service || true)"
      tailscale status >/dev/null 2>&1 && tailscale_state=ok || true
      health_failed=false
      [ "$tailscale_state" = ok ] || health_failed=true
      [ "$t3code_state" = active ] || health_failed=true
      [ "$sshd_state" = active ] || health_failed=true
      if [ "$health_failed" = true ]; then
          sudo "$previous/bin/switch-to-configuration" switch || true
          pr="$(gh api "repos/$GH_REPO/commits/$commit/pulls" --jq '.[0].number // empty' || true)"
          if [ -n "$pr" ]; then
              marker='<!-- deployer-health-gate -->'
              body="$(printf '%s\n%s\n\n%s' "$marker" "Deployer health gate failed on pewter at $(date -u +%Y-%m-%dT%H:%M:%SZ). Rolled back to the previous generation." "Failed probes: tailscale=$tailscale_state, t3code=$t3code_state, sshd=$sshd_state")"
              comment="$(gh api "repos/$GH_REPO/issues/$pr/comments" --paginate --jq '.[] | select(.body | startswith("<!-- deployer-health-gate -->")) | .id' | head -n1)"
              if [ -n "$comment" ]; then
                  gh api --method PATCH "repos/$GH_REPO/issues/comments/$comment" -f body="$body" >/dev/null
              else
                  gh pr comment "$pr" --repo "$GH_REPO" --body "$body"
              fi
          fi
          exit 1
      fi
    '';
  };
in
{
  environment.systemPackages = [
    updater
    deployer
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
        OnCalendar = "daily";
        Persistent = true;
        RandomizedDelaySec = "30m";
      };
    };

    services.flake-deployer = {
      description = "Deploy verified main to pewter and run the health gate";
      serviceConfig = {
        Type = "oneshot";
        User = username;
        StateDirectory = "flake-deployer";
        ExecStart = "${deployer}/bin/flake-deployer";
      };
    };
    timers.flake-deployer = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "03:00";
        Persistent = true;
        RandomizedDelaySec = "30m";
      };
    };
  };
}
