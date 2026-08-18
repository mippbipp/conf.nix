{
  pkgs,
  ...
}@args:
let
  background-opacity = args.background-opacity or 0.50;
in
{
  programs.ghostty = {
    enable = true;
    package = if pkgs.stdenv.hostPlatform.isDarwin then pkgs.ghostty-bin else pkgs.ghostty;
    enableZshIntegration = true;
    settings = {
      background = "000000";
      inherit background-opacity;
      confirm-close-surface = false;
      window-decoration = "none";
      window-padding-x = 4;
      keybind = "ctrl+enter=ignore";
      shell-integration-features = "sudo,title,ssh-env,ssh-terminfo";
    };
  };
  xdg.mimeApps = {
    defaultApplications = {
      "x-scheme-handler/terminal" = "com.mitchellh.ghostty.desktop";
    };
    associations.added = {
      "x-scheme-handler/terminal" = "com.mitchellh.ghostty.desktop";
    };
  };
}
