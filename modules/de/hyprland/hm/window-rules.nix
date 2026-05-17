{
  wayland.windowManager.hyprland.settings = {

    # Assign specific workspaces to monitors
    workspace = [
      "1, monitor:$EXTERNAL"
      "2, monitor:$EXTERNAL"
    ];

    windowrule = [
      # Idle Inhibit
      {
        name = "inhibit-fullscreen-idle";
        match.class = "^(.*)$";
        match.fullscreen = true;
        idle_inhibit = "fullscreen";
      }

      # Workspace Assignments
      {
        name = "ghostty-cursor-workspace1";
        match.class = "^(com.mitchellh.ghostty|cursor)$";
        workspace = 1;
      }
      {
        name = "zen-workspace2";
        match.class = "^(zen.*)$";
        workspace = 2;
      }
      {
        name = "browsers-games-workspace3";
        match.class = "^(((google\\-)?chrome.*)|com.obsproject.Studio|xmcl|steam|net.lutris.Lutris|lunarclient|Lunar\\s+Client.*)$";
        workspace = 3;
      }
      {
        name = "spotify-workspace4";
        match.class = "^([Ss]potify)$";
        workspace = 4;
      }
      {
        name = "virt-manager-workspace6";
        match.class = "^(virt-manager)$";
        workspace = 6;
      }

      # window rules
      {
        name = "polkit";
        match.class = "^(org.kde.polkit-kde-authentication-agent-1)$";
        float = true;
      }
      {
        name = "zoom";
        match.class = "([Zz]oom)";
        float = true;
      }
      {
        name = "xdg-portal";
        match.class = "(xdg-desktop-portal-gtk)";
        float = true;
        size = "70% 70%";
      }
      {
        name = "image-viewer";
        match.class = "^(eog|org.gnome.Loupe)$";
        float = true;
      }
      {
        name = "files";
        match.class = "^(org.gnome.Nautilus|file-roller|org.gnome.FileRoller)$";
        float = true;
        size = "60% 70%";
      }
      {
        name = "pavucontrol";
        match.class = "^(pavucontrol|org.pulseaudio.pavucontrol|com.saivert.pwvucontrol)$";
        float = true;
        size = "70% 70%";
      }
      {
        name = "theme-tools";
        match.class = "^(nwg-look|qt5ct|qt6ct)$";
        float = true;
        size = "60% 70%";
      }
      {
        name = "media-player";
        match.class = "^(mpv|com.github.rafostar.Clapper)$";
        float = true;
        size = "70% 70%";
      }
      {
        name = "network-tools";
        match.class = "^(nm-applet|nm-connection-editor|.blueman-manager-wrapped)$";
        float = true;
        size = "70% 70%";
      }
      {
        name = "system-monitor";
        match.class = "^(gnome-system-monitor|org.gnome.SystemMonitor|io.missioncenter.MissionCenter)$";
        float = true;
        size = "70% 70%";
      }
      {
        name = "kvantum-manager";
        match.title = "(Kvantum Manager)";
        float = true;
        size = "60% 70%";
      }
      {
        name = "qalculate";
        match.class = "^([Qq]alculate-gtk)$";
        float = true;
      }
      {
        name = "pip";
        match.title = "^(Picture-in-Picture)$";
        float = true;
        size = "25% 25%";
        pin = true;
      }
      {
        name = "auth";
        match.title = "^(Authentication Required)$";
        float = true;
      }
    ];
  };
}
