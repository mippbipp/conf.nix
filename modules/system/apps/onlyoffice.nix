{ inputs, pkgs, ... }:
{
  environment.systemPackages = [
    inputs.onlyoffice.packages.${pkgs.stdenv.hostPlatform.system}.onlyoffice-desktopeditors
  ];
}
