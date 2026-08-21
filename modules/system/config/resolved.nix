{ host, nextdns-id, ... }:
{
  services.resolved = {
    enable = true;
    settings = {
      Resolve = {
        Domains = [
          "~."
        ];
        DNS = [
          # nextdns
          "45.90.28.0#${host}-${nextdns-id}.dns.nextdns.io"
          "2a07:a8c0::#${host}-${nextdns-id}.dns.nextdns.io"
          "45.90.30.0#${host}-${nextdns-id}.dns.nextdns.io"
          "2a07:a8c1::#${host}-${nextdns-id}.dns.nextdns.io"
        ];
        DNSOverTLS = "yes";
      };
    };
  };
}
