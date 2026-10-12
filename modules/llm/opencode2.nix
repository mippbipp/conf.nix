# opencode2 API + web server, reachable via Tailscale Serve HTTPS.
#
# Note: `serve --service` makes this unit THE registered background service
# (same `~/.local/state/opencode/service.json` local CLIs discover), with the
# persistent password from `~/.config/opencode/service.json`, so `opencode2
# pair`, plain `opencode2`, and `--server` clients all work with stable creds.
# Plain `serve` instead mints an ephemeral password per start (printed once on
# stdout), which would break remote clients on every unit restart. Do not run
# a second server as this user (e.g. `opencode2 service start`); local TUIs
# attach to this unit automatically via service discovery.
{
  pkgs,
  username,
  ...
}:
let
  inherit (pkgs) opencode2;
  opencode2_port = "4096";
in
{
  environment.systemPackages = [
    opencode2
  ];

  tailnetExpose.opencode2 = {
    httpsPort = 8443;
    backend = "http://127.0.0.1:${opencode2_port}";
    dependsOn = [ "opencode2.service" ];
  };

  systemd.services.opencode2 = {
    description = "opencode2 API + web server (loopback, via Tailscale Serve)";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      User = username;
      WorkingDirectory = "/home/${username}";
      ExecStart = "${opencode2}/bin/opencode2 serve --service --hostname 127.0.0.1 --port ${opencode2_port}";
      Restart = "always";
      RestartSec = 5;
    };
  };
}
