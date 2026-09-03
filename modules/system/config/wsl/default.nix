# NixOS-WSL specific system config, shared by the WSL hosts.
{
  pkgs,
  username,
  lib,
  ...
}:
{
  wsl = {
    # Cold boot took ~18s (HM 6.5s + nftables 6s + tailscaled 2s, see
    # `systemd-analyze blame`), but WSL only waits 10s for /sbin/init by
    # default (`WaitForBootProcess ... failed to start within 10000ms`),
    # then races CreateLoginSession against a not-yet-ready logind and
    # warns `Failed to start the systemd user session`. Wait 30s instead
    # so the login session is attempted after multi-user.target is ready.
    # (Host firewall/nftables are disabled below, removing the nftables
    # leg; initTimeout covers the HM + tailscaled remainder.)
    wslConf.boot.initTimeout = 30000;
    useWindowsDriver = true;

    # Stop WSL from overwriting /etc/resolv.conf on every boot
    # systemd-resolved provides better fidelity with custom DNS
    wslConf.network.generateResolvConf = false;
  };

  # common.nix forces avahi-daemon.socket on for socket activation, but
  # WSL hosts don't enable avahi (no printing.nix), leaving a socket
  # with no service ExecStart that spams `Unit has no Listen setting`
  # on every boot. Disable it here; bare-metal keeps the shared default.
  systemd.sockets.avahi-daemon.wantedBy = lib.mkForce [ ];

  # When the CreateLoginSession race still trips, there is no logind
  # user session for the whole Windows session. Lingering starts
  # user@UID at boot regardless, so user units, the dbus session, and
  # gnome-keyring work even then. This does not prevent the warning
  # itself (linger gives a `manager` session, WSL wants a `user`
  # login session) — initTimeout above is the actual fix.
  users.users.${username}.linger = true;

  networking = {
    resolvconf.enable = false;
    # WSL is NATed behind Windows (Windows firewall is the perimeter) and
    # tailscaled filters via tailnet ACLs, so the NixOS host firewall only
    # serializes boot (nftables -> network-pre -> tailscaled, ~6s cold) for
    # no coverage: no sshd, loopback-bound services, verified identical
    # `tailscale status/ping` with nixos-fw flushed. Drop the whole unit.
    # (This also retires the old rpfilter workaround — Microsoft's WSL2
    # kernel lacks CONFIG_NFT_FIB_IPV6 — since there is no ruleset left.)
    # mkForce wins over common.nix and the tailscale module's plain `true`.
    firewall.enable = lib.mkForce false;
    nftables.enable = lib.mkForce false;
  };
  services.resolved = {
    enable = true;
    settings.Resolve.FallbackDNS = [ "10.255.255.254" ]; # cat /etc/resolv.conf, default for WSL
  };

  imports = [
    ../secret.nix
  ];
  environment.systemPackages = with pkgs; [
    wl-clipboard
  ];
}
