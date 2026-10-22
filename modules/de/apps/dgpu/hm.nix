{
  inputs,
  lib,
  pkgs,
  ...
}:
let
  dgpu = pkgs.callPackage ./package.nix { inherit inputs; };
in
{
  home.packages = [ dgpu.cli ];

  programs.vicinae = {
    extensions = [ dgpu.extension ];
  };

  systemd.user.services.dgpu-reconcile = {
    Unit.Description = "Reconcile dGPU wrapper desktop entries";
    Service = {
      Type = "oneshot";
      ExecStart = lib.getExe dgpu.cli;
    };
    Install.WantedBy = [ "default.target" ];
  };
}
