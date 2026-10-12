# Fleet layer, NixOS side: what every host gets, plus what each Role flag
# selects.
{
  ...
}:
{
  imports = [
    ./registry.nix

    # Fleet-wide baseline.
    ../system/config/common.nix
    ../system/config/dns.nix
    ../system/config/nix.nix
    ../system/config/programs.nix
    ../system/config/tailscale

    # Selected by Role flag.
    ../system/config/sops.nix
    ../system/config/sops-work.nix
    ../ssh/system.nix
  ];
}
