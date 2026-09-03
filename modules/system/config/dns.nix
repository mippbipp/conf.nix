# Single owner for fleet DNS resolution policy.
#
# Standard hosts get the Host-local resolver: systemd-resolved forwarding
# `~.` to NextDNS over DoT with per-host endpoint attribution. The host on
# the corporate network (isWorkPc Role flag) refuses the Tailnet global
# nameserver and routes MagicDNS only, because that network blocks NextDNS
# even over DoH (see ADR-0012). The Tailnet global nameserver itself stays declared in the
# Tailnet policy file; the dns-profile-sync flake check asserts the profile
# still matches on both sides of that seam.
{
  pkgs,
  config,
  lib,
  host,
  globals,
  ...
}:
let
  isWorkPc = config.fleet.hosts.${host}.isWorkPc;
  inherit (globals) nextdns;
in
{
  services.tailscale = lib.mkIf isWorkPc {
      extraUpFlags = [ "--accept-dns=false" ];
      extraSetFlags = [ "--accept-dns=false" ];
    };

    systemd.services.tailscale-magicdns-split = lib.mkIf isWorkPc {
      description = "Route MagicDNS domains to Tailscale MagicDNS (Quad100)";
      after = [
        "tailscaled.service"
        "tailscaled-set.service"
        "systemd-resolved.service"
      ];
      wants = [ "tailscaled.service" ];
      # Don't block multi-user.target on Tailscale being Running: that adds
      # ~3s to the boot critical chain and trips WSL's 10s init timeout
      # (`wsl.wslConf.boot.initTimeout`). Attach to tailscaled instead so
      # this starts alongside multi-user completion, and re-runs on
      # `systemctl restart tailscaled` via partOf.
      wantedBy = [ "tailscaled.service" ];
      # Re-run whenever tailscaled restarts: a restart destroys tailscale0 and
      # replays the startup DNS reconfig, both of which drop our routes, while
      # this unit would otherwise stay exited-0 and never re-apply them.
      partOf = [ "tailscaled.service" ];
      # tailscaled.service being active does not mean configured: its startup
      # DNS reconfig (accept-dns=false enforces empty state) runs during
      # Starting, after the service is already active, and wipes routes applied
      # any earlier. So require BackendState=Running, fail fast otherwise, and
      # retry in the background (no rate limit) rather than dying on systemd's
      # default start burst limit. Nothing orders on this unit, so retries never
      # stall the boot transaction.
      unitConfig = {
        StartLimitIntervalSec = 0;
      };
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        Restart = "on-failure";
        # Poll fast: attempts are ~100ms fail-fast probes, and polling stops
        # for good on first success, so this only costs a few forks per boot
        # while shrinking the Running -> routes gap to ~2s.
        RestartSec = 2;
        ExecStart = pkgs.writeShellScript "tailscale-dns-split" ''
          status=$(${pkgs.tailscale}/bin/tailscale status --json 2>/dev/null)
          state=$(echo "$status" | ${pkgs.jq}/bin/jq -r '.BackendState // empty')
          suffix=$(echo "$status" | ${pkgs.jq}/bin/jq -r '.MagicDNSSuffix // empty')
          [ "$state" = "Running" ] || exit 1 # not configured yet; retry via systemd
          [ -n "$suffix" ] && [ "$suffix" != "." ] || exit 1 # retry via systemd

          ${pkgs.systemd}/bin/resolvectl dns tailscale0 100.100.100.100
          ${pkgs.systemd}/bin/resolvectl domain tailscale0 "~ts.net" "$suffix"
          ${pkgs.systemd}/bin/resolvectl default-route tailscale0 false
        '';
      };
    };
    services.resolved = lib.mkIf (!isWorkPc) {
      enable = true;
      settings = {
        Resolve = {
          Domains = [
            "~."
          ];
          DNS = nextdns.DNS host;
          DNSOverTLS = "yes";
        };
      };
    };
  }
