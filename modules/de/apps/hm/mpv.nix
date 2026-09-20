_:
{
  programs.mpv = {
    enable = true;
    # https://wiki.nixos.org/wiki/Accelerated_Video_Playback#MPV
    config = {
      hwdec = "auto-safe";
      vo = "gpu";
      profile = "gpu-hq";
      gpu-context = "wayland"; # On wayland only
    };
  };
}
