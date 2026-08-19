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

    # nvidia: iGPU-default policy (docs/adr/0004-gram-gpu-policy.md) — no session-wide
    # NVIDIA forcing; offload launch vars belong to individual app launches only.
    # AQ_DRM_DEVICES is colon-separated, first = primary renderer (Hyprland/aquamarine).
    # Auto-detected at login so this works on any machine and survives unstable DRM
    # card numbering across boots: every non-NVIDIA card is concatenated first, the
    # NVIDIA card(s) last, so the dGPU is never primary.
    {
      _primary=
      _offload=
      for _c in /sys/class/drm/card[0-9]*; do
        [ -e "$_c" ] || continue
        case "$_c" in *-*) continue ;; esac
        case "$(sed -n 's/^DRIVER=//p' "$_c/device/uevent" 2>/dev/null)" in
          nvidia) _offload="$_offload:''${_c##*/}" ;;
          *) _primary="$_primary:''${_c##*/}" ;;
        esac
      done
      _list=''${_primary}''${_offload}
      _list=''${_list#:}
      if [ -n "$_list" ]; then
        export AQ_DRM_DEVICES="$(printf '%s' "$_list" | sed 's|^|/dev/dri/|; s|:|:/dev/dri/|g')"
      fi
      unset _primary _offload _list _c
    }
  '';

  xdg.configFile."uwsm/env-hyprland".text = ''
    # hyprcursor
    export HYPRCURSOR_THEME=${config.stylix.cursor.name}
    export HYPRCURSOR_SIZE=${toString config.stylix.cursor.size}
  '';
}
