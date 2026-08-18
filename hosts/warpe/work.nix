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
  caBundle = "/etc/ssl/certs/ca-certificates.crt";
in
{
  security.pki.certificateFiles = lib.mkIf hasCert [
    certFile
  ];

  nix.settings = lib.mkIf hasCert {
    ssl-cert-file = caBundle;

    # Makes the generated system bundle readable in build sandboxes.
    extra-sandbox-paths = [
      caBundle
    ];
  };

  systemd.services.nix-daemon.environment = lib.mkIf hasCert {
    # Nix
    NIX_SSL_CERT_FILE = caBundle;

    # OpenSSL-compatible clients
    SSL_CERT_FILE = caBundle;

    # curl and Python requests
    CURL_CA_BUNDLE = lib.mkForce caBundle;
    REQUESTS_CA_BUNDLE = caBundle;

    # Git
    GIT_SSL_CAINFO = caBundle;
    NIX_GIT_SSL_CAINFO = caBundle;

    # Cargo/libcurl
    CARGO_HTTP_CAINFO = caBundle;
  };
}
