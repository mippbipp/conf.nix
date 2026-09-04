{
  user.name = "mippbipp"; # also matches git username

  nextdns = rec {
    id = "7b9721";
    DNS = host: [
      "45.90.28.0#${host}-${id}.dns.nextdns.io"
      "2a07:a8c0::#${host}-${id}.dns.nextdns.io"
      "45.90.30.0#${host}-${id}.dns.nextdns.io"
      "2a07:a8c1::#${host}-${id}.dns.nextdns.io"
    ];
  };

  # Attic cache: the single owner for every cache string in the flake.
  # Structured URL/key pairs (positional lists drift); the fleet entry is
  # derived from endpoint/cacheName so the three spellings of the own cache
  # (host, URL, cache:ref) collapse to two strings. Consumers (nix.nix pull
  # lists, attic.nix serving path, deployer/nrs push) interpolate the derived
  # values; the attic-cache-sync flake check pins the Build gate YAML.
  cache = rec {
    host = "cache.mippbipp.com";
    endpoint = "https://${host}";
    cacheName = "fleet";
    caches = [
      {
        url = "${endpoint}/${cacheName}";
        key = "fleet:6knXbqLkC7Mgd7CImcsLqeTQ27Y+7E7nBLx/hQgCHGY=";
      }
      {
        url = "https://hyprland.cachix.org";
        key = "hyprland.cachix.org-1:a7pgxzMz7+chwVL3/pzj6jIBMioiJM7ypFP8PwtkuGc=";
      }
      {
        url = "https://winapps.cachix.org/";
        key = "winapps.cachix.org-1:HI82jWrXZsQRar/PChgIx1unmuEsiQMQq+zt05CD36g=";
      }
      {
        url = "https://vicinae.cachix.org";
        key = "vicinae.cachix.org-1:1kDrfienkGHPYbkpNj1mWTr7Fm1+zcenzgTizIcI3oc=";
      }
      {
        url = "https://attic.xuyh0120.win/lantian";
        key = "lantian:EeAUQ+W+6r7EtwnmYjeVwx5kOGEBpjlBfPlzGlTNvHc=";
      }
      {
        url = "https://cache.numtide.com";
        key = "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=";
      }
    ];
    substituters = map (c: c.url) caches;
    trustedKeys = map (c: c.key) caches;
  };

  # Per-machine records live in modules/fleet.nix (typed Role flags behind the
  # fleet.hosts interface). This file keeps only identity, DNS profile, and
  # cache strings, which stay plain data.
}
