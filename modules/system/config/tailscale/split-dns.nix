# Per-host split DNS: route MagicDNS domains via Tailscale MagicDNS (100.100.100.100).
{ pkgs, ... }: {
  systemd.services.tailscale-magicdns-split = {
    description = "Route MagicDNS domains to Tailscale MagicDNS (Quad100)";
    after = [
      "tailscaled.service"
      "systemd-resolved.service"
    ];
    wants = [ "tailscaled.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      Restart = "on-failure";
      RestartSec = 2;
      ExecStart = pkgs.writeShellScript "tailscale-dns-split" ''
        suffix=$(${pkgs.tailscale}/bin/tailscale status --json 2>/dev/null \
          | ${pkgs.jq}/bin/jq -r '.MagicDNSSuffix // empty')
        [ -n "$suffix" ] && [ "$suffix" != "." ] || exit 1  # retry via systemd

        ${pkgs.systemd}/bin/resolvectl dns tailscale0 100.100.100.100
        ${pkgs.systemd}/bin/resolvectl domain tailscale0 "~ts.net" "$suffix"
        ${pkgs.systemd}/bin/resolvectl default-route tailscale0 false
      '';
    };
  };
}
