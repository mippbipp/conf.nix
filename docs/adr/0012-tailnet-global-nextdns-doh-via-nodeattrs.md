# Universal Tailnet Global via NextDNS DoH and `nodeAttrs` (fixes phone internet loss)

## Context

After ADR 0005 made the Tailnet global nameserver (`terraform/tailscale/main.tf:47` `tailscale_dns_configuration.global` with `override_local_dns=true` and 4 bare `45.90.28.0`/`45.90.30.0` sentinels) required for iOS MagicDNS (`docs/adr/0005:3` — without a global, iOS Firefox `1.102.2` got `NXDOMAIN` for `https://pewter.tail3f9fd2.ts.net`), and ADR 0006 put strict `DNSOverTLS=yes` on every NixOS host importing `modules/system/config/resolved.nix` (`modules/globals.nix:4` `7b9721` with per-host SNI `${host}-7b9721.dns.nextdns.io`), the phone lost **all** internet on **every** network except tailnet itself when connected — no exit node enabled. `gram`/`pewter` appeared fine (home / Oracle networks don't block UDP 53), `warpe` had already worked around the same class with `isWorkPc -> --accept-dns=false` (`modules/system/config/tailscale/default.nix:38`, `c41e716` "company wifi blocks nextdns nameserver") and keeps its island.

Grill-with-docs confirmed: (1) universal filtered setup desired, no phone-specific handling; (2) failure is universal, not just work wifi; (3) `fail-closed` on `443` is acceptable; (4) control plane stays declarative in `terraform/tailscale/`; (5) `warpe` stays split-DNS only (`hosts/warpe/config.nix:20-21` is the only importer of `modules/system/config/tailscale/split-dns.nix:21`); (6) profile sentinel is `2a07:a8c0::7b:9721`.

## Discovery

Tailnet global was plaintext UDP 53 to `45.90.28.0`. `terraform/tailscale/main.tf:49` `override_local_dns=true` forces every client that honors DNS to send `~.` there. On NixOS hosts that accept DNS (`gram`, `pewter`, `harpe` when tailscaled) `tailscaled`'s systemd-resolved integration makes `tailscale0` the default, so internet queries left via that bare IP — not via the host-local `resolved.nix` DoT. The host-local resolver (`CONTEXT.md` Host-local resolver) is then **not** a fallback when connected; it is the path that survives `tailscaled` down. Only `warpe` bypasses the global (`--accept-dns=false`) and wires `MagicDNS` explicitly via `split-dns.nix` (`resolvectl domain tailscale0 "~ts.net"` + `default-route false`) so company DNS answers internet.

The tailnet global was also mis-wired: `terraform/tailscale/main.tf:37-42` had only `nextdns:no-device-info` on `*` and four generic anycast IPs with the comment `API has no NextDNS ID field; ID 7b9721 expands to 4 IPs below.` For NextDNS, Tailscale's only supported transport is DoH (`Tailscale only uses NextDNS with DNS over HTTPS`, `https://tailscale.com/kb/1054/dns`), and the profile ID belongs in the Tailnet policy file as `nodeAttrs` `nextdns:<id>`, not as an IP expansion. Without `nextdns:7b9721`, the sentinel is treated as a plain UDP resolver and is blocked by most carriers/captive portals.

## Decision

Keep `override_local_dns=true` (still required for iOS per 0005) and universal filtering, but make the global DoH-correct:

* `terraform/tailscale/main.tf:37` `nodeAttrs` becomes `[{target=["*"] attr=["nextdns:7b9721","nextdns:no-device-info"]}]` — one universal mapping, no phone-specific target.
* `terraform/tailscale/main.tf:51` `nameservers` becomes a single sentinel `address="2a07:a8c0::7b:9721"` (profile `7b9721` linked IPv6 from NextDNS > Setup > Endpoints) with `use_with_exit_node=true`. The control plane maps that sentinel to DoH `https://dns.nextdns.io/7b9721` over `443/TCP`; no `45.90.28.0` UDP path remains.
* `warpe` stays as is: `isWorkPc` `--accept-dns=false` + `split-dns.nix` island, no `resolved.nix` (`hosts/warpe/config.nix:20-21`). Company WiFi blocks NextDNS even over DoH, so the island is load-bearing. Revisiting it is a separate decision.
* Glossary sharpened in `CONTEXT.md` (Host-local resolver vs Tailnet global nameserver vs MagicDNS vs Override local DNS) to prevent the "resolved.nix is fallback/redundant" misreading.

## Consequences

* Phone and any future host that accepts DNS get internet everywhere `443` is open (home, cellular, hotel) via DoH, plus MagicDNS `*.ts.net` via `100.100.100.100`, plus NextDNS filtering for `7b9721` without per-device `phone-*` logs.
* Hosts that accept DNS (`gram`, `pewter`) now also resolve internet via tailnet DoH when tailscaled is up; when tailscaled is down they fall through to host-local `resolved.nix` DoT (strict, fails closed on `853`). The two layers are complementary, not redundant — ADR 0006's layering principle is preserved.
* `warpe` still needs exit-node detours to avoid leaking corporate DNS; no change.
* If a network blocks `443` or performs DoH MITM, DNS now fails closed (same trade as 0006's `853` choice). Captive portals may need tailnet disconnect.
* One-time `tofu -chdir=terraform/tailscale apply` pushes the sentinel + `nodeAttrs`; no console edit, no device-local NextDNS profile on the phone.

## Rejected

* Switching global to `1.1.1.1`/`8.8.8.8`: fixes availability but drops universal `7b9721` filtering — trades the invariant for a workaround.
* `override_local_dns=false` + `split_dns { domain="tail3f9fd2.ts.net" nameservers { address="100.100.100.100" } }`: leaves phone on local ISP/DoH, most resilient, but loses declarative filtering and diverges per device (rejected in 0005).
* Keeping four bare `45.90.28.0` IPs + adding `nextdns:7b9721`: works today, but keeps undocumented sentinels and masks the intended single-profile IPv6 path.
* Per-device `nextdns:gram-…` attribution on tailnet: viable later with additional `nodeAttrs` targets, not needed for universal fix.
