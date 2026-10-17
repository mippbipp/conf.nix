# Shared agent skills auto-sync: pull-only mirror of ~/.agents/skills.
# See README.md beside this module for key selection and host setup.
{ pkgs, host, ... }:
let
  skillsPull = pkgs.writeShellScript "skills-sync-pull" ''
    key="$HOME/.ssh/${host}_ed25519"
    export GIT_SSH_COMMAND="${pkgs.openssh}/bin/ssh -i $key -o IdentitiesOnly=yes -o BatchMode=yes"
    # --ff-only fails on dirty state instead of merging.
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
