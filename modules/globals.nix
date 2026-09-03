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

  # Per-machine records live in modules/fleet.nix (typed Role flags behind the
  # fleet.hosts interface). This file keeps only identity and DNS profile,
  # which stay plain data.
}
