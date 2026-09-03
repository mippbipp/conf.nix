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
      mkdir -p "$repo_dir"
      if [ ! -d "$repo_dir/.git" ]; then
          git clone "https://github.com/$GH_REPO.git" "$repo_dir"
      fi
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

  deployer = pkgs.writeShellApplication {
    name = "flake-deployer";
    runtimeInputs = with pkgs; [
      attic-client
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
      git config --local url."https://github.com/".insteadOf "git@github.com:"
      git -c fetch.recurseSubmodules=false -c submodule.recurse=false fetch --prune origin main
      git -c submodule.recurse=false checkout -B main origin/main
      # The pinned submodule commit may not be on any upstream branch
      # (e.g. after an upstream amend/force-push). A plain submodule update
      # then fails, so fetch the pinned SHA explicitly and retry once.
      if ! git -c 'url.https://github.com/.insteadOf=git@github.com:' submodule update --init --recursive; then
          git config --file .gitmodules --get-regexp '\.path$' | cut -d' ' -f2 | while read -r sub; do
              read -r _ _ pinned _ <<< "$(git ls-tree HEAD -- "$sub")"
              if [ -n "$pinned" ] && { [ -d "$sub/.git" ] || [ -f "$sub/.git" ]; }; then
                  git -C "$sub" fetch origin "$pinned" || true
              fi
          done
          git -c 'url.https://github.com/.insteadOf=git@github.com:' submodule update --init --recursive
      fi

      commit="$(git rev-parse HEAD)"
      pr="$(gh api "repos/$GH_REPO/commits/$commit/pulls" --jq '.[0].number // empty' || true)"
      if [ -z "$pr" ]; then
          echo "main commit has no associated merged PR: $commit" >&2
          exit 1
      fi
      check_commit="$(gh pr view "$pr" --repo "$GH_REPO" --json headRefOid --jq '.headRefOid')"
      # Generalize over every `build <host>` check so new hosts are covered
      # without editing the deployer. The Build gate names one job per host.
      check_runs_url="repos/$GH_REPO/commits/$check_commit/check-runs?per_page=100"
      build_count="$(gh api "$check_runs_url" --jq '[.check_runs[] | select(.name | startswith("build "))] | length')"
      if [ -z "$build_count" ] || [ "$build_count" = "0" ]; then
          echo "no Build gate checks found on $check_commit" >&2
          exit 1
      fi
      failed="$(gh api "$check_runs_url" --jq '[.check_runs[] | select(.name | startswith("build ")) | select(.conclusion != "success")] | map(.name) | join(", ")')"
      if [ -n "$failed" ]; then
          echo "required Build gate checks are not successful: $failed" >&2
          exit 1
      fi

      previous="$(readlink -f /run/current-system)"
      if ! /run/wrappers/bin/sudo nixos-rebuild switch --flake ".?submodules=1#pewter"; then
          /run/wrappers/bin/sudo "$previous/bin/switch-to-configuration" switch || true
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
          /run/wrappers/bin/sudo "$previous/bin/switch-to-configuration" switch || true
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

      # Publish the deployed closure so other hosts and future Build gate
      # runs can substitute it. Push failure must not roll back a healthy
      # switch, but it should fail the service so the timer goes red.
      attic_token="$(< ${config.sops.secrets.attic_cache_token.path})"
      attic login cache https://cache.mippbipp.com "$attic_token"
      attic push cache:fleet /run/current-system
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
        OnCalendar = "Mon *-*-* 02:00:00";
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
        OnCalendar = "Mon *-*-* 06:00:00";
        Persistent = true;
        RandomizedDelaySec = "30m";
      };
    };
  };
}
