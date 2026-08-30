{
  config,
  pkgs,
  ...
}:
{
  # systemd reads the environment file before dropping to Attic's DynamicUser.
  sops.secrets.attic_jwt_secret.owner = "root";

  services.atticd = {
    enable = true;
    environmentFile = config.sops.secrets.attic_jwt_secret.path;
    settings = {
      listen = "127.0.0.1:8080";
      allowed-hosts = [ "cache.mippbipp.com" ];
      api-endpoint = "https://cache.mippbipp.com/";
      database.url = "postgresql://atticd@/atticd?host=/run/postgresql";
      storage = {
        type = "local";
        path = "/var/lib/atticd/storage-postgresql";
      };
      garbage-collection = {
        interval = "12 hours";
        default-retention-period = "30 days";
      };
    };
  };

  environment.systemPackages = with pkgs; [
    attic-client
    nginx
  ];
  services.postgresql = {
    enable = true;
    ensureDatabases = [ "atticd" ];
    ensureUsers = [
      {
        name = "atticd";
        ensureDBOwnership = true;
      }
    ];
  };

  security.acme = {
    acceptTerms = true;
    defaults.email = "anthonypasala12@gmail.com";
  };

  services.nginx = {
    enable = true;
    recommendedProxySettings = true;
    virtualHosts."cache.mippbipp.com" = {
      enableACME = true;
      forceSSL = true;
      extraConfig = "client_max_body_size 0;";
      locations."/".proxyPass = "http://127.0.0.1:8080";
    };
  };

  networking.firewall.allowedTCPPorts = [
    80
    443
  ];
}
