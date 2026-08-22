{ host, globals, ... }:
let
  inherit (globals) nextdns;
in
{
  services.resolved = {
    enable = true;
    settings = {
      Resolve = {
        Domains = [
          "~."
        ];
        DNS = nextdns.DNS host;
        DNSOverTLS = "yes";
      };
    };
  };
}
