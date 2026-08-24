# NixOS-WSL specific system config, shared by the WSL hosts.
{
  lib,
  ...
}:
{

  wsl = {
    useWindowsDriver = true;

    # Let systemd-resolved DNS here too. With generation on, WSL writes
    # /etc/resolv.conf pointing at the Windows resolver and nothing ever
    # queries systemd-resolved's stub.
    wslConf.network.generateResolvConf = false;
  };

  # WSL2 kernel rejects the nft `fib` expression that reverse-path
  # filtering uses; override the "loose" that nixpkgs' tailscale
  # module sets for clients
  networking.firewall.checkReversePath = lib.mkForce false;
}
