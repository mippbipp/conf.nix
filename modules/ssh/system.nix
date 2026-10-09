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
      # this instead of silently reverting to nixpkgs' weaker defaults. Root
      # over key only, since pewter's initrd authorizedKeys depend on it.
      settings.PermitRootLogin = "prohibit-password";
      settings.PasswordAuthentication = false;
      openFirewall = true;
    }
    (lib.mkIf acceptsSsh {
      enable = true;
      # Assigning replaces nixpkgs' [22] rather than adding to it. The firewall
      # above opens exactly this port.
      ports = [ sshPort ];
    })
  ];
}
