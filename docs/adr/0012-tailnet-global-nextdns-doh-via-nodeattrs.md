# Tailnet global uses NextDNS DoH via nodeAttrs

Making the tailnet global required for iOS per ADR 0005 fixed MagicDNS on the phone, but the global was plaintext UDP and blocked on most networks. With `override_local_dns` on, every client that accepts DNS sent `~.` there, and the phone lost internet everywhere except on tailnet. NixOS hosts that accept DNS were also affected; only `warpe` avoided it via split-DNS.

We keep `override_local_dns` but move the global to DoH. The Tailnet policy file declares `nextdns:7b9721` in `nodeAttrs` and the sentinel becomes the profile's linked IPv6. Tailscale then maps that sentinel to `https://dns.nextdns.io/7b9721` over 443. No bare anycast IPs remain. `warpe` stays split-DNS because company WiFi blocks NextDNS even over DoH.

The host-local resolver and the tailnet global are complementary, not redundant: the global covers tailnet clients, the host-local survives `tailscaled` being down.

Rejected: switching to a public resolver (drops filtering), disabling `override_local_dns` (loses iOS coverage), or keeping bare IPs alongside the attr (masks the intended path).

Status: accepted
