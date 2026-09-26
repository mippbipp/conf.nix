_: {
  services.displayManager.ly = {
    enable = true;
    settings = {
      clock = "%c";
      save = true;
      animation = "dur_file";
      dur_file_path = "${../wallpapers/blackhole-smooth-240x67.dur}";
      full_color = true; # for 256-color dur files
    };
  };
}
