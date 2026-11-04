{
  lib,
  pkgs,
  config,
  host,
  globals,
  inputs,
  ...
}:
{
  imports = [
    ./opencode/app.nix
  ];

  home = {
    # Shared agent skills live in a submodule of this repo, so the
    # checkout is the single source of truth.
    file.".agents/skills".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/conf.nix/modules/llm/skills";

    packages =
      with pkgs;
      [
        kiro-cli
        inputs.axonometric.packages.${pkgs.stdenv.hostPlatform.system}.default
        t3code
      ];
  };
}
