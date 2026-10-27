{
  lib,
  pkgs,
  config,
  host,
  globals,
  ...
}:
{
  programs.opencode = lib.mkIf (!globals.hosts.${host}.isWorkPc) {
    enable = true;
    package = pkgs.opencode2;
    settings.plugins = [
      {
        package = "opencode-kiro@0.5.2";
        options = {
          agent = "opencode";
        };
      }
    ];
  };

  # Shared agent skills live in a private submodule of this repo, so the
  # checkout is the single source of truth.
  home.file.".agents/skills".source =
    config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/conf.nix/modules/llm/skills";

  home.packages =
    with pkgs;
    [
      kiro-cli
    ]
    ++ lib.optionals (!globals.hosts.${host}.isServer) [
      t3code.desktop
    ];
}
