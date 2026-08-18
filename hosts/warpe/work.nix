# Work laptop CA bundle. company-root.pem is exported from Windows (see
# hosts/warpe/README.md) and committed — a CA root is public material.
# The guard keeps this flake evaluable on machines without the pem.
{
  lib,
  ...
}:
let
  certFile = ./company-root.pem;
  hasCert = builtins.pathExists certFile;
in
{
  security.pki.certificateFiles = lib.mkIf hasCert [
    certFile
  ];

  nix.settings = lib.mkIf hasCert {
    ssl-cert-file = "/etc/ssl/certs/ca-certificates.crt";
    extra-sandbox-paths = [
      "/etc/ssl/certs/ca-certificates.crt"
    ];
  };

  systemd.services.nix-daemon.environment = lib.mkIf hasCert {
    NIX_SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
    NIX_GIT_SSL_CAINFO = "/etc/ssl/certs/ca-certificates.crt";
    GIT_SSL_CAINFO = "/etc/ssl/certs/ca-certificates.crt";
  };
}
