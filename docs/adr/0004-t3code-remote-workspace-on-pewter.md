# t3code remote workspace on pewter over Tailscale Serve

pewter — the always-on Oracle ARM VM and tailnet exit node — runs a NixOS-managed t3code server so any tailnet device (iOS app on brick, desktop app, hosted web app) can drive its opencode against projects on pewter. The server is generic: no projects pre-registered; clients add projects after pairing. No opencode credentials are needed — the config stays empty and the free models require no auth.

Transport is Tailscale Serve HTTPS: the unit runs `t3 serve --mode web --host 127.0.0.1 --tailscale-serve`, so the backend is loopback-only and clients reach it at `https://pewter.<tailnet>.ts.net/` (serve mapping persists until `tailscale serve --https=443 off`). The tailscale module grants the user serve rights declaratively via `services.tailscale.extraSetFlags = [ "--operator=<user>" ]` on pewter (runs `tailscale set --operator` through the module's `tailscaled-set` oneshot); the t3code unit is `After=tailscaled.service` + `tailscaled-set.service`, `Restart=always`, runs as the user with `WorkingDirectory=/home/<user>` (t3 state in `~/.t3`, opencode state in `~/.local/share/opencode`). New devices pair with `t3 pair` on pewter (one-time token/QR); after that, sessions. iOS clients additionally require a tailnet global nameserver for MagicDNS to resolve the serve hostname — see ADR 0005.

The t3code package override (codex off, opencode from llm-agents) moved from `modules/hm/devenv/default.nix` into a shared nixpkgs overlay in `flake.nix`, applied to all hosts; the devenv module and the systemd unit both consume `pkgs.t3code`.

Remote sessions default to Supervised permission mode (client-side, per-thread) because the agent can run passwordless `sudo nixos-rebuild` on the always-on exit node.

Considered and rejected: `t3 service install` (npm-managed user unit — bypasses the nixpkgs pin, second update channel, not declarative), raw `--host <tailnet-ip>` HTTP on 3773 (exposes the port tailnet-wide, breaks the hosted web app via mixed content, no TLS), a user-level systemd unit (needs linger and PATH/state juggling), and T3 Connect (account-based relay — unneeded while every device is on the tailnet).
