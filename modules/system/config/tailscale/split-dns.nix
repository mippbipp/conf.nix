# split DNS between tailscale MagicDNS and computer DNS
{ pkgs, ... }: {

  # Once tailscale0 exists, tell resolved: route *.ts.net to Quad100 only
  systemd.services.tailscale-magicdns-split = {
    description = "Route *.ts.net queries to Tailscale MagicDNS (Quad100) only";
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
