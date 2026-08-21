{
  inputs,
  pkgs,
  username,
  host,
  lib,
  sopsSecrets,
  ...
}:
{
  home.packages =
    let
      llm = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system};
      llms = [
        llm.opencode2
      ];
    in
    with pkgs;
    [
      eza
      sccache
      pnpm
      nodejs
      python312
      rust-bin.stable.latest.default
      uv
      go
      tokei
      repomix
      (import ./scripts/nrs.nix { inherit pkgs username host; })
      t3code # see flake.nix
    ]
    ++ llms;

  imports = [
    ./git.nix
    ./neovim.nix
    ./starship.nix
    ./superfile/default.nix
    ./herdr/default.nix
  ];

  home.sessionVariables = {
    RUSTC_WRAPPER = "${pkgs.sccache}/bin/sccache";
    SCCACHE_CACHE_SIZE = "50G";
    NODE_COMPILE_CACHE = "$HOME/.cache/nodejs-compile-cache";

    # Go
    GOPATH = "$HOME/go";
    GOBIN = "$HOME/go/bin";
    GOPROXY = "direct";

    # nvim marksman
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = 1;
  };

  programs = {
    direnv = {
      enable = true;
      enableZshIntegration = true;
      nix-direnv.enable = true;
    };
    zoxide = {
      enable = true;
      enableZshIntegration = true;
      options = [
        "--cmd cd"
      ];
    };
    zsh = {
      enable = true;
      autosuggestion.enable = true;
      enableCompletion = true;
      history = {
        ignoreDups = true;
        ignoreAllDups = true;
        expireDuplicatesFirst = true;
      };
      oh-my-zsh = {
        enable = true;
        theme = "robbyrussell";
        plugins = [
          "git"
          "fzf"
        ];
      };
      initContent =
        let
          zshConfig = ''
            # Source personal configurations if they exist
            if [ -f $HOME/.zshrc-personal ]; then
              source $HOME/.zshrc-personal
            fi

            # gh CLI auth from sops-managed token (see modules/sops)
            if [ -f ${sopsSecrets.github_token.path} ]; then
              export GH_TOKEN="$(< ${sopsSecrets.github_token.path})"
            fi

            eval "$(uv generate-shell-completion zsh)"
            eval "$(uvx --generate-shell-completion zsh)"
          '';
        in
        lib.mkMerge [
          zshConfig
        ];
      shellAliases = {
        v = "nvim";
        sv = "sudo nvim";
        ncg = "nix-collect-garbage --delete-old && sudo nix-collect-garbage -d && sudo /run/current-system/bin/switch-to-configuration boot";
        cat = "bat";
        ls = "eza --icons";
        ll = "eza -lh --icons --group-directories-first";
        la = "eza -lah --icons --group-directories-first";
        ".." = "cd ..";
      };
    };
  };
}
