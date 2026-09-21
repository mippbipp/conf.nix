# Shared agent skills auto-sync: pull-only mirror of ~/.agents/skills.
# See README.md beside this module for key selection and host setup.
{ pkgs, host, ... }:
let
  skillsPull = pkgs.writeShellScript "skills-sync-pull" ''
    # Prefer a dedicated read-only deploy key when present (e.g. hector, which
    # carries no personal identity by design); fall back to the per-host key.
    key="$HOME/.ssh/${host}_skills_ed25519"
    [ -f "$key" ] || key="$HOME/.ssh/${host}_ed25519"
    export GIT_SSH_COMMAND="${pkgs.openssh}/bin/ssh -i $key -o IdentitiesOnly=yes -o BatchMode=yes"
    # --ff-only fails loud on dirty state instead of merging.
    exec ${pkgs.git}/bin/git -C "$HOME/.agents/skills" pull --ff-only
  '';
in
{
  systemd.user.services.skills-sync = {
    Unit = {
      Description = "Pull shared agent skills (~/.agents/skills)";
      After = [ "network-online.target" ];
      Wants = [ "network-online.target" ];
      # skips hosts where repo isn't cloned
      ConditionPathExists = [ "%h/.agents/skills/.git" ];
    };
    Service = {
      Type = "oneshot";
      ExecStart = "${skillsPull}";
    };
  };

  systemd.user.timers.skills-sync = {
    Unit = {
      Description = "Pull shared agent skills every 5 minutes";
    };
    Timer = {
      OnBootSec = "2min";
      OnUnitActiveSec = "5min";
      Unit = "skills-sync.service";
    };
    Install = {
      WantedBy = [ "timers.target" ];
    };
  };
}
