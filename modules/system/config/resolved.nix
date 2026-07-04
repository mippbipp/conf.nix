{ host, ... }: {
  services.resolved = {
    enable = true;
    settings = {
      Resolve = {
        Domains = [
          # MagicDNS for tailscale
          "~."
        ];
        DNS = [
          # nextdns
          "45.90.28.0#${host}-7b9721.dns.nextdns.io"
          "2a07:a8c0::#${host}-7b9721.dns.nextdns.io"
          "45.90.30.0#${host}-7b9721.dns.nextdns.io"
          "2a07:a8c1::#${host}-7b9721.dns.nextdns.io"
        ];
        DNSOverTLS = "yes";
      };
    };
  };
}
