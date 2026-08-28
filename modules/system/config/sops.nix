{
  inputs,
  pkgs,
  username,
  ...
}:
{
  imports = [ inputs.sops-nix.nixosModules.sops ];

  environment.systemPackages = with pkgs; [
    sops
    age
  ];

  sops = {
    defaultSopsFile = ../../../secrets.yaml;
    defaultSopsFormat = "yaml";
    age.keyFile = "/var/lib/sops-nix/keys.txt";
    secrets = {
      git_config.owner = username;
      github_token.owner = username;
      tailscale_tailnet.owner = username;
      tailscale_oauth_client_id.owner = username;
      tailscale_oauth_client_secret.owner = username;
    };
  };
}
