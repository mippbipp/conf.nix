# NixOS-WSL specific system config, shared by the WSL hosts.
{
  lib,
  ...
}:
{
  # WSL2 kernel rejects the nft `fib` expression that reverse-path
  # filtering uses; override the "loose" that nixpkgs' tailscale
  # module sets for clients
  networking.firewall.checkReversePath = lib.mkForce false;
}
