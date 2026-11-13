# t3code remote workspaces on pewter and gram over Tailscale Serve

pewter, the always-on Oracle ARM VM and tailnet exit node, and gram, the laptop, each run a NixOS-managed t3code server so any tailnet device (iOS app on brick, desktop app on warpe, hosted web app) can drive their opencode against projects on that host. Both import the same `modules/llm/t3code/server.nix`. The server is generic: no projects pre-registered; clients add projects after pairing. No opencode credentials are needed. The config stays empty and the free models require no auth.

Two servers let a client such as warpe connect to both and use t3code's Auto balance (Settings → Environments → Load balancing, saved per client) to pick a machine for new threads. Auto balance only places new threads in projects grouped across environments, so a project needs a checkout on both hosts; running threads never move. gram drops out of balancing while asleep or off, so pewter stays the host that is always reachable.

Transport is Tailscale Serve HTTPS: the unit runs `t3 serve --mode web --host 127.0.0.1 --tailscale-serve`, so the backend is loopback-only and clients reach it at `https://<host>.<tailnet>.ts.net/` (serve mapping persists until `tailscale serve --https=443 off`). The tailscale module grants the user serve rights declaratively via `services.tailscale.extraSetFlags = [ "--operator=<user>" ]` on any host with a `tailnetExpose` entry (runs `tailscale set --operator` through the module's `tailscaled-set` oneshot); the t3code unit is `After=tailscaled.service` + `tailscaled-set.service`, `Restart=always`, runs as the user with `WorkingDirectory=/home/<user>` (t3 state in `~/.t3`, opencode state in `~/.local/share/opencode`). New devices pair with `t3 pair` on each host (one-time token/QR); after that, sessions. iOS clients additionally require a tailnet global nameserver for MagicDNS to resolve the serve hostname. See ADR 0005.

The t3code package override (opencode as its only provider) lives in `modules/llm/t3code/overlay.nix`, which the shared nixpkgs overlay in `modules/llm/overlay.nix` imports for all hosts; the devenv module and the systemd unit both consume `pkgs.t3code`. Pewter also serves `opencode` on 8443 (`modules/llm/t3code/server.nix` and `modules/llm/opencode/server.nix`, both exposed through the `tailnetExpose` interface in `modules/system/config/tailscale/serve.nix`).

Remote sessions default to Supervised permission mode (client-side, per-thread) because the agent can run passwordless `sudo nixos-rebuild` on the always-on exit node.

Considered and rejected: `t3 service install` (npm-managed user unit), raw `--host <tailnet-ip>` HTTP on 3773, a user-level systemd unit, T3 Connect (account-based relay), and desktop-managed SSH from warpe to gram (installs an unmanaged server into `~/.t3/runtime` that only runs while warpe's app manages it).

Status: accepted
