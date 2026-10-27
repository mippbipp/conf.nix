# ADR 0004: t3code Remote workspace server, reachable via Tailscale Serve HTTPS.
{
  pkgs,
  username,
  ...
}:
{
  environment.systemPackages = [
    pkgs.t3code
  ];

  tailnetExpose.t3code = {
    httpsPort = 443; # t3code's default, passed in here to avoid port collision
    backend = null;
  };

  systemd.services.t3code = {
    description = "t3code remote workspace server";
    wantedBy = [ "multi-user.target" ];
    after = [
      "tailscaled.service"
      "tailscaled-set.service" # runs `tailscale set --operator` before the server needs it
    ];
    # Re-run whenever tailscaled restarts
    partOf = [ "tailscaled.service" ];
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
