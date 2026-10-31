{
  inputs,
  ...
}:
{
  imports = [
    inputs.hex.homeManagerModules.hex
  ];
  programs.hex = {
    enable = true;
    autostart = true;
    settings = {
      # Declaring this key replaces the whole Global mode, including
      # anything changed in Hex's Modes pane.
      "dictation_processing.default_mode" = {
        name = "Global";
        applications = [ ];
        browser_hosts = [ ];
        replacements = [ ];
        transformations = [ "lowercase" ];
        post_processing = {
          enabled = false;
          deadline_seconds = 30;
          model = null;
          variant = null;
          prompt = "Rewrite the transcript into clear, natural text while preserving the speaker's intended meaning.";
        };
      };
    };
  };
}
