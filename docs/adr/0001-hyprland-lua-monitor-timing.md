# Hyprland Lua monitor rules must handle the load-time monitor gap

The Lua config is loaded before the backend starts, so `hl.get_monitors()` is empty at first launch; monitor rules registered only at load time are therefore never applied until the next reload. The fix is a two-path pattern in `modules/de/hyprland/lua/monitors.lua`:

- **Load-time loop** over `hl.get_monitors()` — registers rules when monitors are already enumerated (every config reload, where `monitor.added` does not re-fire).
- **`monitor.added` handler** — registers rules as monitors appear (first launch, when the load-time loop is a no-op, and runtime hotplug).

Never emit a wildcard rule (`output = ""`) while the monitor list is unknown: it pins auto scaling on every monitor. Hyprland's built-in fallback rule already gives unconfigured monitors preferred mode, auto position, and PPI-based auto scale. Note that auto scale is PPI-driven (`getDefaultScale()`: >200 PPI → 2, >140 → 1.5, else 1), so an unconfigured 141 PPI laptop panel silently renders at 1.5 — which is how this bug surfaced.

Status: accepted
