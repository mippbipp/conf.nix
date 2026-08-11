local mod = H.mod
local term = H.env.terminal
local env = H.env

hl.bind(mod .. " + mouse:272", hl.dsp.window.drag(), { mouse = true })
hl.bind(mod .. " + mouse:273", hl.dsp.window.resize(), { mouse = true })

hl.bind(mod .. " + Return", hl.dsp.exec_cmd(term))
hl.bind(mod .. " + B", hl.dsp.exec_cmd("pidof waybar >/dev/null && pkill -SIGUSR1 waybar || waybar &"))
hl.bind(mod .. " + SHIFT + N", hl.dsp.exec_cmd("swaync-client -t -sw"))
hl.bind(mod .. " + ALT + L", hl.dsp.exec_cmd("pidof hyprlock || hyprlock -q"))
hl.bind("CTRL + ALT + P", hl.dsp.exec_cmd(env.wlogout))
hl.bind(mod .. " + SHIFT + C", hl.dsp.exec_cmd("hyprpicker -a"))
hl.bind("CTRL + ALT + Delete", hl.dsp.exit())

hl.bind(mod .. " + Q", hl.dsp.window.close())
hl.bind(mod .. " + F", hl.dsp.window.fullscreen())
hl.bind(mod .. " + SHIFT + F", hl.dsp.window.float({ action = "toggle" }))

hl.bind("ALT + tab", hl.dsp.window.cycle_next())
hl.bind("ALT + tab", hl.dsp.window.alter_zorder({ mode = "top" }))

hl.bind(mod .. " + h", hl.dsp.focus({ direction = "left" }))
hl.bind(mod .. " + l", hl.dsp.focus({ direction = "right" }))
hl.bind(mod .. " + k", hl.dsp.focus({ direction = "up" }))
hl.bind(mod .. " + j", hl.dsp.focus({ direction = "down" }))

hl.bind(mod .. " + SHIFT + h", hl.dsp.window.move({ direction = "left" }))
hl.bind(mod .. " + SHIFT + l", hl.dsp.window.move({ direction = "right" }))
hl.bind(mod .. " + SHIFT + k", hl.dsp.window.move({ direction = "up" }))
hl.bind(mod .. " + SHIFT + j", hl.dsp.window.move({ direction = "down" }))

hl.bind("XF86AudioMute", hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"), { repeating = true })
hl.bind("XF86AudioRaiseVolume", hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%+"), { repeating = true })
hl.bind("XF86AudioLowerVolume", hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"), { repeating = true })
hl.bind("XF86AudioPlay", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
hl.bind("XF86AudioPause", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
hl.bind("XF86AudioNext", hl.dsp.exec_cmd("playerctl next"), { locked = true })
hl.bind("XF86AudioPrev", hl.dsp.exec_cmd("playerctl previous"), { locked = true })
hl.bind("XF86AudioStop", hl.dsp.exec_cmd("playerctl stop"), { locked = true })

-- PrintScreen key pressed -> the currently focused monitor is captured, and the Flameshot GUI launches
hl.bind("Print", function()
	local mon = hl.get_active_monitor()
	local n = mon and mon.id or 0
	hl.exec_cmd("flameshot screen --number " .. n .. " --edit")
end)
hl.bind(mod .. " + SHIFT + S", hl.dsp.exec_cmd("flameshot gui"))
hl.bind(mod .. " + SHIFT + T", hl.dsp.exec_cmd("normcap"))

hl.bind(mod .. " + tab", hl.dsp.focus({ workspace = "m+1" }))
hl.bind(mod .. " + SHIFT + tab", hl.dsp.focus({ workspace = "m-1" }))
hl.bind(mod .. " + SHIFT + m", hl.dsp.workspace.move({ monitor = "+1" }))
hl.bind(mod .. " + mouse_down", hl.dsp.focus({ workspace = "e+1" }))
hl.bind(mod .. " + mouse_up", hl.dsp.focus({ workspace = "e-1" }))
hl.bind(mod .. " + period", hl.dsp.focus({ workspace = "e+1" }))
hl.bind(mod .. " + comma", hl.dsp.focus({ workspace = "e-1" }))

hl.bind(mod .. " + SHIFT + U", hl.dsp.window.move({ workspace = "special:1" }))
hl.bind(mod .. " + U", hl.dsp.workspace.toggle_special())

hl.bind(mod .. " + Space", hl.dsp.exec_cmd("vicinae vicinae://toggle"))
hl.bind(mod .. " + V", hl.dsp.exec_cmd("vicinae vicinae://launch/clipboard/history?toggle=true"))

hl.bind("XF86MonBrightnessDown", hl.dsp.exec_cmd(env.brightness .. " --dec"), { repeating = true })
hl.bind("XF86MonBrightnessUp", hl.dsp.exec_cmd(env.brightness .. " --inc"), { repeating = true })

for i = 1, 10 do
	local key = i % 10
	hl.bind(mod .. " + " .. key, hl.dsp.focus({ workspace = i }))
	hl.bind(mod .. " + SHIFT + " .. key, hl.dsp.window.move({ workspace = i }))
end
