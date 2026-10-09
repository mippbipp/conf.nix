# Fleet layer, Home Manager side: what every host gets, plus what each Role
# flag selects. See ADR-0020.
{
  ...
}:
{
  imports = [
    # Fleet-wide baseline.
    ../hm/config.nix
    ../hm/devenv
    ../ssh/hm.nix

    # Selected by Role flag; each module gates itself.
    ../hm/devenv/work-git.nix
  ];
}
