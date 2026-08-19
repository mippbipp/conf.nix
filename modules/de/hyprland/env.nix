{ config, ... }:
{
  xdg.configFile."uwsm/env".text = ''
    # hyprland
    export SDL_VIDEODRIVER=wayland
    export CLUTTER_BACKEND=wayland
    export GDK_BACKEND=wayland,x11,*
    export QT_AUTO_SCREEN_SCALE_FACTOR=1
    export QT_QPA_PLATFORM="wayland;xcb"
    export QT_QPA_PLATFORMTHEME=qt6ct
    export QT_SCALE_FACTOR=1
    export QT_WAYLAND_DISABLE_WINDOWDECORATION=1
    export XDG_CURRENT_DESKTOP=Hyprland
    export XDG_SESSION_TYPE=wayland
    export XDG_SESSION_DESKTOP=Hyprland

    # nix
    export NIXOS_OZONE_WL=1
    export NIXPKGS_ALLOW_UNFREE=1

    # display: primary-renderer policy (docs/adr/0004-gram-gpu-policy.md) — no
    # session-wide NVIDIA forcing; offload launch vars belong to individual launches.
    # AQ_DRM_DEVICES is colon-separated, first = primary renderer (Hyprland/aquamarine).
    # Vendor-agnostic, so this works on any machine (Intel, AMD, NVIDIA): GPUs owning
    # the internal panel (eDP/DSI/LVDS) come first, then GPUs with a connected display,
    # then the rest. Auto-detected at login, surviving unstable DRM card numbering.
    {
      _panel=
      _display=
      _rest=
      for _c in /sys/class/drm/card[0-9]*; do
        [ -e "$_c" ] || continue
        case "$_c" in *-*) continue ;; esac
        _why=
        for _s in "$_c"-eDP-* "$_c"-DSI-* "$_c"-LVDS-*; do
          [ -e "$_s" ] && _why=panel
        done
        if [ -z "$_why" ]; then
          for _s in "$_c"-*-*; do
            [ -e "$_s" ] && [ "$(cat "$_s/status" 2>/dev/null)" = connected ] && _why=display
          done
        fi
        case "$_why" in
          panel) _panel="$_panel:''${_c##*/}" ;;
          display) _display="$_display:''${_c##*/}" ;;
          *) _rest="$_rest:''${_c##*/}" ;;
        esac
      done
      _list=''${_panel}''${_display}''${_rest}
      _list=''${_list#:}
      if [ -n "$_list" ]; then
        export AQ_DRM_DEVICES="$(printf '%s' "$_list" | sed 's|^|/dev/dri/|; s|:|:/dev/dri/|g')"
      fi
      unset _panel _display _rest _why _s _c
    }
  '';

  xdg.configFile."uwsm/env-hyprland".text = ''
    # hyprcursor
    export HYPRCURSOR_THEME=${config.stylix.cursor.name}
    export HYPRCURSOR_SIZE=${toString config.stylix.cursor.size}
  '';
}
