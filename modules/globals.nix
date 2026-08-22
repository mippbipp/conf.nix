{
  nextdns = rec {
    id = "7b9721";
    DNS = host: [
      "45.90.28.0#${host}-${id}.dns.nextdns.io"
      "2a07:a8c0::#${host}-${id}.dns.nextdns.io"
      "45.90.30.0#${host}-${id}.dns.nextdns.io"
      "2a07:a8c1::#${host}-${id}.dns.nextdns.io"
    ];
  };

  # hosts
  pewter = {
    name = "pewter";
    sshPort = 2222; # set in oracle cloud security list ingress rules
    luksHostname = "129.146.202.171";
  };
  gram = {
    name = "gram";
    pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIyaPm21KDiQAXbzoG0IS7KO8rwcrP2ZqwJjW6uvh29A wovw@gram";
  };
  harpe.name = "harpe";
  warpe.name = "warpe";
}
