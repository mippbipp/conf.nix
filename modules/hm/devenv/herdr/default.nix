{
  inputs,
  pkgs,
  lib,
  ...
}:
let
  herdrPkg = inputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  home.packages = [
    (import ./scripts/ws.nix {
      inherit
        pkgs
        herdrPkg
        ;
    })
  ];

  programs.herdr = {
    enable = true;
    package = herdrPkg;
    settings = {
      onboarding = false;
      keys = {
        prefix = "ctrl+a";
        previous_tab = "alt+h";
        next_tab = "alt+l";
        previous_workspace = "ctrl+alt+h";
        next_workspace = "ctrl+alt+l";
        detach = "prefix+d";
        command = [
          {
            key = "prefix+f";
            type = "pane";
            command = "ws";
            description = "open project picker";
          }
        ];
      };
      ui = {
        sound.enabled = false;
        sidebar_start_collapsed = true;
        sidebar_collapsed_mode = "hidden";
        tab_bar_position = "bottom";
        prompt_new_tab_name = false;
      };
    };
  };

  programs.zsh.initContent =
    let
      herdrZsh = ''
        function session-widget() {
            # Preserve terminal context by using zsh's BUFFER
            BUFFER="ws"
            # Execute the command
            zle accept-line
        }
        zle -N session-widget
        bindkey '^f' session-widget

        # autoconnect herdr on ssh
        if [ -n "$SSH_TTY" ] && [ -z "$HERDR_ENV" ]; then
          exec herdr --session ssh_session
        fi
      '';
    in
    lib.mkMerge [
      herdrZsh
    ];
}
