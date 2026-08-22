{ host, ... }:
let
  inherit (import ../../globals.nix) nextdns;
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
