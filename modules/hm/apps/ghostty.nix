{
  pkgs,
  ...
}:
{
  programs.ghostty = {
    enable = true;
    package = if pkgs.stdenv.isDarwin then pkgs.ghostty-bin else pkgs.ghostty;
    enableZshIntegration = true;
    settings = {
      background = "000000";
      background-opacity = 0.50;
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
