# One browse relay, on hosts whose Chrome has the browse extension (hasDE
# like gram). The extension there stays on localhost:19988; other hosts'
# agents reach that relay through two proxies:
#
#   agent on pewter -> pewter 127.0.0.1:19988 -> gram tailnet :19989
#                   -> gram 127.0.0.1:19988 (the relay)
#
# The relay answers agents only from loopback, and browse's clients only dial
# 127.0.0.1, so each end needs a loopback proxy. Agents authenticate with the
# relay token, which every host shares through sops.
{
  globals,
  host,
  lib,
  pkgs,
  username,
  ...
}:
let
  browserHost = "gram";
  relayPort = 19988;
  tailnetPort = 19989;
  proxyd = "${pkgs.systemd}/lib/systemd/systemd-socket-proxyd";
  isBrowserHost = globals.hosts.${host}.hasDE;
in
{
  sops.secrets.browse_relay_token = {
    owner = username;
    path = "/home/${username}/.local/share/browse/relay-token";
  };

  systemd = lib.mkMerge [
    (lib.mkIf isBrowserHost {
      # The firewall admits this port from tailscale0 only (trustedInterfaces).
      sockets.browse-relay-tailnet = {
        description = "browse relay for other tailnet hosts";
        wantedBy = [ "sockets.target" ];
        listenStreams = [ (toString tailnetPort) ];
      };
      services.browse-relay-tailnet = {
        description = "Proxy tailnet :${toString tailnetPort} to the browse relay on loopback";
        serviceConfig = {
          ExecStart = "${proxyd} 127.0.0.1:${toString relayPort}";
          DynamicUser = true;
        };
      };

      user.services.browse-relay = {
        description = "browse relay";
        wantedBy = [ "default.target" ];
        serviceConfig = {
          ExecStart = "${lib.getExe pkgs.opencode-browse} serve";
          Restart = "on-failure";
          RestartSec = 5;
        };
      };
    })

    (lib.mkIf (!isBrowserHost) {
      sockets.browse-relay-forward = {
        description = "browse relay on ${browserHost}";
        wantedBy = [ "sockets.target" ];
        listenStreams = [ "127.0.0.1:${toString relayPort}" ];
      };
      services.browse-relay-forward = {
        description = "Forward 127.0.0.1:${toString relayPort} to the browse relay on ${browserHost}";
        serviceConfig = {
          ExecStart = "${proxyd} ${browserHost}.${globals.tailnet.suffix}:${toString tailnetPort}";
          DynamicUser = true;
        };
      };
    })
  ];

  # The relay lives on the browser host, so neither the MCP server (started
  # by opencode's unit, without the session's variables) nor the CLI should
  # start a local one when it's unreachable.
  home-manager.users.${username} = lib.mkIf (!isBrowserHost) {
    programs.opencode.settings.mcp.servers.browse.environment.OPENCODE_BROWSER_AUTOSTART = "0";
    home.sessionVariables.OPENCODE_BROWSER_AUTOSTART = "0";
  };
}
