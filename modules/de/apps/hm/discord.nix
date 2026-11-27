{ pkgs, ... }:
{
  home.packages = with pkgs; [
    discord
  ];

  # https://wiki.nixos.org/wiki/Discord#%22Must_be_your_lucky_day%22
  # Discord rewrites this file at runtime, so overwrite it instead of letting
  # Home Manager back it up.
  xdg.configFile."discord/settings.json" = {
    force = true;
    text = ''
      {
        "SKIP_HOST_UPDATE": true,
        "MINIMIZE_TO_TRAY": false,
        "SKIP_MODULE_UPDATE": true
      }
    '';
  };
}
