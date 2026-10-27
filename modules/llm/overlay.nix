# Shared nixpkgs overlays for every host
{
  imports = [
    ./opencode/overlay.nix
    ./t3code/overlay.nix
  ];
}
