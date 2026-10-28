{ inputs, ... }:
{
  nixpkgs.overlays = [
    (
      final: prev:
      let
        llm = inputs.llm-agents.packages.${final.stdenv.hostPlatform.system};
      in
      {
        t3code = llm.t3code.override {
          providerPackages = [ final.opencode ];
        };
      }
    )
  ];
}
