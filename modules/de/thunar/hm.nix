{ pkgs, terminal }: {
  xfconf.settings = {
    thunar = {
      "last-show-hidden" = true;
      "last-view" = "ThunarDetailsView";
      "last-details-view-visible-columns" =
        "THUNAR_COLUMN_NAME,THUNAR_COLUMN_SIZE,THUNAR_COLUMN_TYPE,THUNAR_COLUMN_MIME_TYPE,THUNAR_COLUMN_DATE_CREATED,THUNAR_COLUMN_DATE_MODIFIED";
      "last-details-view-column-order" =
        "THUNAR_COLUMN_NAME,THUNAR_COLUMN_SIZE,THUNAR_COLUMN_TYPE,THUNAR_COLUMN_MIME_TYPE,THUNAR_COLUMN_DATE_CREATED,THUNAR_COLUMN_DATE_MODIFIED";
    };
  };

  home.packages = [
    (pkgs.writeShellScriptBin "${terminal}-thunar" ''
      exec ${terminal} --working-directory="$PWD" "$@"
    '')
  ];

  # XFCE Helper: registers the wrapper so exo-open knows how to run it
  xdg.dataFile."xfce4/helpers/${terminal}-thunar.desktop".text = ''
    [Desktop Entry]
    NoDisplay=true
    Version=1.0
    Encoding=UTF-8
    Type=X-XFCE-Helper
    X-XFCE-Category=TerminalEmulator
    X-XFCE-CommandsWithParameter=${terminal}-thunar -e "%s"
    X-XFCE-Commands=${terminal}-thunar
  '';
  xdg.configFile."xfce4/helpers.rc".text = ''
    TerminalEmulator=${terminal}-thunar
  '';
}
