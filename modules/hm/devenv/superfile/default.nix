{
  inputs,
  lib,
  pkgs,
  username,
  ...
}:
{
  home.packages = with pkgs; [
    trash-cli
    exiftool # metadata plugin
  ];

  programs = {
    superfile = {
      enable = true;
      package = inputs.superfile.packages.${pkgs.stdenv.hostPlatform.system}.default;

      settings = {
        auto_check_update = false;
        cd_on_quit = false; # configured in zsh
        zoxide_support = true;
        metadata = true;
      };

      firstUseCheck = false;
      pinnedFolders = [
        {
          name = "Projects";
          location = "/home/${username}/Projects";
        }
        {
          name = "work";
          location = "/home/${username}/work";
        }
        {
          name = "things";
          location = "/home/${username}/things";
        }
      ];
    };

    zsh.initContent = lib.mkMerge [
      ''
        # spf cd-on-exit: press Q to quit and cd into the last directory
        spf() {
          export SPF_LAST_DIR="''${XDG_STATE_HOME:-$HOME/.local/state}/superfile/lastdir"
          command superfile "$@"
          [ ! -f "$SPF_LAST_DIR" ] || {
            . "$SPF_LAST_DIR"
            rm -f -- "$SPF_LAST_DIR" > /dev/null
          }
        }
      ''
    ];
  };
}
