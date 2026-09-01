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

  hosts = {
    gram = {
      pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIyaPm21KDiQAXbzoG0IS7KO8rwcrP2ZqwJjW6uvh29A wovw@gram";
      syncId = "STSZHNC-PHDMSOV-LLJUNMR-VZHVO5X-NERCW7A-OIEO36S-Y4YVMVK-H7FRKAP";
    };
    harpe = { };
    warpe = {
      isWorkPc = true;
      pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJFlGnfX0uWipIXc1rpZap0ZxEdGTi4s+QhxriJ5bBcM mippbipp@warpe";
    };
    pewter = {
      sshPort = 2222; # set in oracle cloud security list ingress rules, used for luks unlocking
      luksHostname = "129.146.202.171";
      syncId = "POHLBBF-3AOYWFT-OK46SCB-Z4O4VHV-5NFB5MH-SX2OP5M-GNYZSTT-5VKEPQT";
      isExitNode = true;
      remoteBuilds = true;
      canSsh = true;
    };
    hector = {
      canSsh = true;
    };
    brick.syncId = "4Q75UQR-3BKJV5G-5DBCANF-FG5OUML-PMWS5XB-LUW2CSK-7RQX6AL-Y7KR4AI";
  };
}
