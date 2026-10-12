{
  config,
  host,
  lib,
  ...
}:
let
  acceptsSsh = config.fleet.hosts.${host}.acceptsSsh;
  sshPort = config.fleet.hosts.${host}.sshPort;
in
{
  services.openssh = lib.mkMerge [
    {
      # Outside the flag on purpose: a host that enables sshd later inherits
      # this instead of silently reverting to nixpkgs' weaker defaults.
      settings.PermitRootLogin = "prohibit-password";
      settings.PasswordAuthentication = false;
      openFirewall = true;
    }
    (lib.mkIf acceptsSsh {
      enable = true;
      # The firewall above opens this port.
      ports = [ sshPort ];
    })
  ];
}
