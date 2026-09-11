# Both opencode2 (V2 preview CLI) and the t3code override (currently on
# opencode V1 via providerPackages; swap to opencode2 when t3code supports
# it) resolve here.
{ inputs, ... }:
{
  nixpkgs.overlays = [
    (
      final: prev:
      let
        llm = inputs.llm-agents.packages.${final.stdenv.hostPlatform.system};
      in
      {
        inherit (llm) opencode2;
        t3code = llm.t3code.override {
          providerPackages = with llm; [ opencode ];
        };
      }
    )
  ];
}
