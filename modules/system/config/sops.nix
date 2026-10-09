{
  config,
  host,
  inputs,
  lib,
  pkgs,
  username,
  ...
}:
let
  # Personal secrets need the shared age identity. Work hosts read the
  # work-only file instead (ADR-0015), but still need the key path below.
  isPersonalHost = config.fleet.hosts.${host}.isPersonalHost;
in
{
  imports = [ inputs.sops-nix.nixosModules.sops ];

  environment.systemPackages = with pkgs; [
    sops
    age
  ];

  sops = {
    defaultSopsFile = ../../../secrets/me.yaml;
    defaultSopsFormat = "yaml";
    age.keyFile = "/var/lib/sops-nix/keys.txt";
    secrets = lib.mkIf isPersonalHost {
      git_config.owner = username;
      github_token.owner = username;
      tailscale_tailnet.owner = username;
      tailscale_oauth_client_id.owner = username;
      tailscale_oauth_client_secret.owner = username;
      attic_jwt_secret.owner = "root";
      attic_cache_token.owner = username;
      cloudflare_api_token.owner = username;
      cloudflare_account_id.owner = username;
      oci_tenancy_id.owner = username;
      oci_user_ocid.owner = username;
      oci_fingerprint.owner = username;
      oci_private_key.owner = username;
      oci_region.owner = username;
      oci_budget_alert_email.owner = username;
    };
  };
}
