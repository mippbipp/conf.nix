{
  username,
  ...
}:
{
  home = {
    username = "${username}";
    homeDirectory = "/home/${username}";
  };

  programs = {
    home-manager.enable = true;
    btop = {
      enable = true;
      settings = {
        vim_keys = true;
        clock_format = "";
        show_battery = false;
        presets = "cpu:0:default,gpu0:0:default,mem:0:default,net:0:default";
      };
    };
  };

  xdg.userDirs = {
    enable = true;
    createDirectories = true;
    setSessionVariables = false;
  };
}
