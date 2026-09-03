# Internal seam for the Updater and Deployer modules on pewter.
#
# Interface: a function of the sops GitHub token path, returning the shell
# prelude both tasks share (auth export plus state-checkout bootstrap).
# The prelude expects the caller's `$repo_dir` to be set. Imported by
# flake-updater.nix and flake-deployer.nix only; never by a host config
# directly.
{ githubTokenPath }:
let
  repo = "mippbipp/conf.nix";
in
{
  exportAuth = ''
      github_token="$(< ${githubTokenPath})"
      export GH_TOKEN="$github_token"
      export GH_REPO="''${GH_REPO:-${repo}}"
      mkdir -p "$repo_dir"
      if [ ! -d "$repo_dir/.git" ]; then
          git clone "https://github.com/$GH_REPO.git" "$repo_dir"
      fi'';
}
