# ADR 0004: t3code remote workspace server, reachable via Tailscale Serve HTTPS
{
  pkgs,
  username,
  ...
}:
{
  environment.systemPackages = [
    pkgs.t3code # see flake.nix
  ];

  # Allow the t3 server (running as $username) to configure `tailscale serve`
  # without sudo. The NixOS tailscale module runs `tailscale set --operator`
  # via the `tailscaled-set` oneshot; `t3 serve --tailscale-serve` then succeeds.
  services.tailscale.extraSetFlags = [ "--operator=${username}" ];

  systemd.services.t3code = {
    description = "t3code remote workspace server";
    wantedBy = [ "multi-user.target" ];
    after = [
      "tailscaled.service"
      "tailscaled-set.service" # runs `tailscale set --operator` before the server needs it
    ];
    # For `t3 serve --tailscale-serve` to configure the serve mapping as $username
    path = [ pkgs.tailscale ];
    serviceConfig = {
      User = username;
      WorkingDirectory = "/home/${username}";
      ExecStart = "${pkgs.t3code}/bin/t3 serve --mode web --host 127.0.0.1 --tailscale-serve";
      Restart = "always";
      RestartSec = 5;
    };
  };
}
