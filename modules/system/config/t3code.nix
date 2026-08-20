# ADR 0005: t3code remote workspace server, reachable via Tailscale Serve HTTPS
{
  pkgs,
  username,
  ...
}:
{
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
      # Backend stays loopback-bound; clients reach it via https://pewter.<tailnet>.ts.net/
      ExecStart = "${pkgs.t3code}/bin/t3 serve --mode web --host 127.0.0.1 --tailscale-serve";
      Restart = "always";
      RestartSec = 5;
    };
  };
}
