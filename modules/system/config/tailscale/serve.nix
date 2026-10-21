# Tailnet expose interface (mechanism: Tailscale Serve HTTPS).
#
# Transport (./default.nix) stays fleet-wide; features declare exposes here
# instead of hand-rolling serve units. Port allocation is data now, so
# collisions fail evaluation.
#
# Two shapes behind one interface:
# - backend != null: this module generates the `<name>-serve` oneshot mapping
#   unit (`tailscale serve --bg --https=<port> <backend>`, as root).
# - backend == null: the app manages its own mapping (e.g. t3code
#   `--tailscale-serve` runs as $username and calls tailscale itself). The
#   expose only reserves the port for collision detection; ordering/operator
#   stay in the feature's backend unit.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.tailnetExpose;
  withBackend = lib.filterAttrs (_: e: e.backend != null) cfg;
  ports = lib.mapAttrsToList (_: e: e.httpsPort) cfg;
  uniquePorts = lib.unique ports;
in
{
  options.tailnetExpose = lib.mkOption {
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          httpsPort = lib.mkOption {
            type = lib.types.port;
            description = "Tailnet HTTPS port tailscaled terminates TLS on.";
          };
          backend = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Loopback backend URL. Null when the app manages its own tailnet mapping.";
            example = "http://127.0.0.1:4096";
          };
          dependsOn = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = "Extra units the mapping waits for (backend units).";
            example = [ "karakeep-web.service" ];
          };
        };
      }
    );
    default = { };
    description = "Tailnet exposures. Keys become `<name>-serve` mapping units when backend is set.";
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = builtins.length ports == builtins.length uniquePorts;
          message = "tailnetExpose.httpsPort collision: ${builtins.toJSON ports}";
        }
      ];
    }
    {
      systemd.services = lib.mapAttrs' (name: e: {
        name = "${name}-serve";
        value = {
          description = "${name} via Tailscale Serve HTTPS :${toString e.httpsPort}";
          wantedBy = [ "multi-user.target" ];
          after = [
            "tailscaled.service"
            "tailscaled-set.service" # operator grant lands before a user-managed mapping needs it
          ]
          ++ e.dependsOn;
          # Re-run whenever these services restart to reset state; e.g. the tailscale serve mapping
          # otherwise persists in tailscaled state until `tailscale serve --https=<port> off`.
          partOf = [ "tailscaled.service" ] ++ e.dependsOn;
          path = [ pkgs.tailscale ];
          # tailscaled is systemd-active before its backend reaches Running, so
          # the first serve call can transiently fail with NoState. Retry
          # indefinitely. --bg is load-bearing: without it `tailscale serve`
          # stays in the foreground and the oneshot times out.
          unitConfig.StartLimitIntervalSec = 0;
          script = "tailscale serve --yes --bg --https=${toString e.httpsPort} ${e.backend}";
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            Restart = "on-failure";
            RestartSec = 2;
          };
        };
      }) withBackend;
    }
  ];
}
