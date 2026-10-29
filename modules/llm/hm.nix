{
  lib,
  pkgs,
  config,
  host,
  globals,
  ...
}:
{
  imports = [
    ./opencode/app.nix
  ];

  home = {
    # Shared agent skills live in a private submodule of this repo, so the
    # checkout is the single source of truth.
    file.".agents/skills".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/conf.nix/modules/llm/skills";

    packages =
      with pkgs;
      [
        kiro-cli
      ]
      ++ lib.optionals (!globals.hosts.${host}.isServer) [
        t3code.desktop
      ];
  };
}
