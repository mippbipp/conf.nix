{ pkgs, ... }:
{
  home.packages = with pkgs; [
    discord
  ];

  # https://wiki.nixos.org/wiki/Discord#%22Must_be_your_lucky_day%22_popup
  xdg.configFile."discord/settings.json".text = ''
    {
      "SKIP_HOST_UPDATE": true,
      "MINIMIZE_TO_TRAY": false
    }
  '';
}
