# Work-only sops secrets.
#
# The pathExists guard keeps the flake evaluable before secrets/work.yaml
# exists (same pattern as hosts/warpe/work.nix), so the Build gate stays green
# until rollout provisions it. The HM side warns instead of failing.
{
  inputs,
  username,
  host,
  config,
  lib,
  ...
}:
let
  enabled = config.fleet.hosts.${host}.usesWorkGit;
  workFile = ../../../secrets/work.yaml;
  hasWorkFile = builtins.pathExists workFile;
in
{
  imports = [ inputs.sops-nix.nixosModules.sops ];
  sops.secrets = lib.mkIf (enabled && hasWorkFile) {
    # Git snippet for the ~/work/ scope
    work_gitconfig = {
      owner = username;
      sopsFile = workFile;
    };
    # ssh Host block for the company GitLab (transport auth key).
    work_ssh_config = {
      owner = username;
      sopsFile = workFile;
    };
    # glab API host (https://...) for GITLAB_HOST.
    work_gitlab_host = {
      owner = username;
      sopsFile = workFile;
    };
    # glab API token (PAT with api scope) for GITLAB_TOKEN.
    work_gitlab_token = {
      owner = username;
      sopsFile = workFile;
    };
  };
}
