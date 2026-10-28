# opencode API + web server, reachable via Tailscale Serve HTTPS.
#
# Note: `serve --service` makes this unit THE registered background service
# (same `~/.local/state/opencode/service.json` local CLIs discover), with the
# persistent password from `~/.config/opencode/service.json`, so `opencode
# pair`, plain `opencode`, and `--server` clients all work with stable creds.
# Plain `serve` instead mints an ephemeral password per start (printed once on
# stdout), which would break remote clients on every unit restart. Do not run
# a second server as this user (e.g. `opencode service start`); local TUIs
# attach to this unit automatically via service discovery.
{
  pkgs,
  username,
  ...
}:
let
  inherit (pkgs) opencode;
  opencode_port = "4096";
in
{
  environment.systemPackages = [
    opencode
  ];

  tailnetExpose.opencode = {
    httpsPort = 8443;
    backend = "http://127.0.0.1:${opencode_port}";
    dependsOn = [ "opencode.service" ];
  };

  systemd.services.opencode = {
    description = "opencode API + web server (loopback, via Tailscale Serve)";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      User = username;
      WorkingDirectory = "/home/${username}";
      ExecStart = "${opencode}/bin/opencode serve --service --hostname 127.0.0.1 --port ${opencode_port}";
      Restart = "always";
      RestartSec = 5;
    };
  };
}
