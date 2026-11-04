_:
{
  nixpkgs.overlays = [
    (
      final: prev:
      {
        t3code = prev.t3code.override {
          enableCodex = false;
          enableGitLab = true;
          enableOpencode = true;
        };
      }
    )
  ];
}
