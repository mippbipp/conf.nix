# Work GitLab identity for dual-use hosts; see ADR-0019.
#
# Under ~/work/, git switches to the work snippet and ssh picks up the work
# Host block; both snippets come from the work-only sops file. `glab` needs
# GITLAB_TOKEN/GITLAB_HOST.
#
# Before secrets/work.yaml is provisioned the module is inert by design (the
# sops side guards on the file's existence) and warns instead of failing.
{
  lib,
  pkgs,
  host,
  globals,
  sopsSecrets,
  ...
}:
let
  flagged = globals.hosts.${host}.usesWorkGit;
  provisioned = sopsSecrets ? work_gitconfig;
  enabled = flagged && provisioned;
in
{
  config = lib.mkMerge [
    {
      warnings =
        lib.optional (flagged && !provisioned)
          "usesWorkGit is set but secrets/work.yaml is not provisioned; the work identity is inert (see ADR-0019 rollout)";
    }
    (lib.mkIf enabled {
      home.packages = [ pkgs.glab ];

      programs = {
        git.includes = [
          {
            condition = "gitdir:~/work/";
            path = sopsSecrets.work_gitconfig.path;
          }
        ];

        # Top-level Include (rendered before host blocks): the work key is tried
        # first, the per-host key from ssh/hm.nix remains as fallback.
        ssh.includes = [ sopsSecrets.work_ssh_config.path ];

        zsh.initContent = ''
          # glab auth for the work instance — guarded so first-boot shells still start.
          # Note: `glab auth status` cannot see env-only auth (it only lists
          # hosts stored via `glab auth login`); verify with `glab api user`.
          if [ -f ${sopsSecrets.work_gitlab_token.path} ]; then
            export GITLAB_TOKEN="$(< ${sopsSecrets.work_gitlab_token.path})"
          fi
          if [ -f ${sopsSecrets.work_gitlab_host.path} ]; then
            export GITLAB_HOST="$(< ${sopsSecrets.work_gitlab_host.path})"
          fi
        '';
      };
    })
  ];
}
