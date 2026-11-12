{
  config,
  lib,
  globals,
  host,
  sopsSecrets,
  sopsTemplates,
  ...
}:
{
  # hosts.yml carries the token, so sops renders it at activation instead of
  # Home Manager writing it to the store.
  xdg.configFile."gh/hosts.yml" = lib.mkIf (sopsTemplates ? "gh-hosts.yml") {
    source = config.lib.file.mkOutOfStoreSymlink sopsTemplates."gh-hosts.yml".path;
  };

  programs = {
    git = {
      enable = true;
      includes = lib.optionals (sopsSecrets ? git_config) [
        { path = sopsSecrets.git_config.path; }
      ];
      lfs.enable = true;
      signing = {
        format = "ssh";
        signByDefault = true;
      };
      settings = {
        user = {
          name = globals.user.name;
          signingkey = "~/.ssh/${host}_ed25519.pub";
        };

        # https://blog.gitbutler.com/how-git-core-devs-configure-git/

        core.symlinks = "true";
        column.ui = "auto";
        branch.sort = "-committerdate";
        tag.sort = "version:refname";
        init.defaultBranch = "main";
        diff = {
          algorithm = "histogram";
          colorMoved = "plain";
          mnemonicPrefix = "true";
          renames = "true";
        };
        push = {
          autoSetupRemote = "true";
          followTags = "true";
        };
        fetch = {
          prune = "true";
          pruneTags = "true";
          all = "true";
        };

        help.autocorrect = "prompt";
        commit.verbose = "true";
        rerere = {
          enabled = "true";
          autoupdate = "true";
        };
        rebase = {
          autoSquash = "true";
          autoStash = "true";
          updateRefs = "true";
        };
        pull.rebase = "true";

        submodule = {
          recurse = "true";
          fetchJobs = 8;
        };
        push.recurseSubmodules = "on-demand";
      };
    };
    lazygit = {
      enable = true;
      settings = {
        git = {
          overrideGpg = true;
        };
      };
    };
    gh = {
      enable = true;
      hosts = lib.mkIf (!(sopsTemplates ? "gh-hosts.yml")) {
        "github.com" = {
          user = globals.user.name;
        };
      };
      settings = {
        git_protocol = "ssh";
        prompt = "enabled";
      };
    };
  };
}
