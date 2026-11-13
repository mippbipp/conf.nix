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

  # The desktop app's own server conflicts with this unit and exits on
  # launch, so disable local environments. The app rewrites this
  # file at runtime, so merge the one key instead of linking a store copy.
  home-manager.users.${username} =
    { lib, pkgs, ... }:
    let
      disableLocalEnvironment = pkgs.writeShellScript "t3code-desktop-no-local-environment" ''
        set -eu
        settings="$HOME/.t3/userdata/desktop-settings.json"
        mkdir -p "$(dirname "$settings")"
        [ -s "$settings" ] || echo '{}' > "$settings"
        if ! ${pkgs.jq}/bin/jq -e 'type == "object"' "$settings" >/dev/null 2>&1; then
          echo "t3code: $settings is not a JSON object, leaving it alone" >&2
          exit 0
        fi
        ${pkgs.jq}/bin/jq -e '.localEnvironmentEnabled == false' "$settings" >/dev/null && exit 0
        ${pkgs.jq}/bin/jq -c '.localEnvironmentEnabled = false' "$settings" > "$settings.tmp"
        mv "$settings.tmp" "$settings"
      '';
    in
    {
      home.activation.t3codeDesktopNoLocalEnvironment = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run ${disableLocalEnvironment}
      '';
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
