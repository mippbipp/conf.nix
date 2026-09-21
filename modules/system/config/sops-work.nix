# Work-only sops secrets (work GitLab identity). Imported only by hosts with
# the usesWorkGit Role flag; see ADR-0019.
#
# The guard keeps the flake evaluable before secrets/work.yaml exists (same
# pattern as hosts/warpe/work.nix): without the file the module is inert and
# the HM side warns instead of failing, so the Build gate stays green until
# rollout provisions it.
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

  sops = {
    age.keyFile = lib.mkDefault "/var/lib/sops-nix/keys.txt";
    secrets = lib.mkIf (enabled && hasWorkFile) {
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
  };
}
