hl.window_rule({
	name = "inhibit-fullscreen-idle",
	match = { class = "^(.*)$", fullscreen = true },
	idle_inhibit = "fullscreen",
})

hl.window_rule({
	name = "ghostty-cursor-workspace1",
	match = { class = "^(com.mitchellh.ghostty|cursor)$" },
	workspace = 1,
})
hl.window_rule({
	name = "zen-workspace2",
	match = { class = "^(zen.*)$" },
	workspace = 2,
})
hl.window_rule({
	name = "browsers-games-workspace3",
	match = {
		class = "^(((google\\-)?chrome.*)|com.obsproject.Studio|xmcl|steam|net.lutris.Lutris|lunarclient|Lunar\\s+Client.*)$",
	},
	workspace = 3,
})
hl.window_rule({
	name = "spotify-workspace4",
	match = { class = "^([Ss]potify)$" },
	workspace = 4,
})
hl.window_rule({
	name = "virt-manager-workspace6",
	match = { class = "^(virt-manager)$" },
	workspace = 6,
})

hl.window_rule({
	name = "polkit",
	match = { class = "^(org.kde.polkit-kde-authentication-agent-1)$" },
	float = true,
})
hl.window_rule({
	name = "zoom",
	match = { class = "([Zz]oom)" },
	float = true,
})
hl.window_rule({
	name = "xdg-portal",
	match = { class = "(xdg-desktop-portal-gtk)" },
	float = true,
	size = { "monitor_w * 0.7", "monitor_h * 0.7" },
})
hl.window_rule({
	name = "image-viewer",
	match = { class = "^(eog|org.gnome.Loupe)$" },
	float = true,
})
hl.window_rule({
	name = "files",
	match = { class = "^(thunar|file-roller|org.gnome.FileRoller)$" },
	float = true,
	size = { "monitor_w * 0.7", "monitor_h * 0.7" },
	center = true,
})
hl.window_rule({
	name = "pavucontrol",
	match = { class = "^(pavucontrol|org.pulseaudio.pavucontrol|com.saivert.pwvucontrol)$" },
	float = true,
	size = { "monitor_w * 0.7", "monitor_h * 0.7" },
})
hl.window_rule({
	name = "theme-tools",
	match = { class = "^(nwg-look|qt5ct|qt6ct)$" },
	float = true,
	size = { "monitor_w * 0.6", "monitor_h * 0.7" },
})
hl.window_rule({
	name = "media-player",
	match = { class = "^(mpv|com.github.rafostar.Clapper)$" },
	float = true,
	size = { "monitor_w * 0.7", "monitor_h * 0.7" },
})
hl.window_rule({
	name = "network-tools",
	match = { class = "^(nm-applet|nm-connection-editor|.blueman-manager-wrapped)$" },
	float = true,
	size = { "monitor_w * 0.7", "monitor_h * 0.7" },
})
hl.window_rule({
	name = "system-monitor",
	match = { class = "^(gnome-system-monitor|org.gnome.SystemMonitor|io.missioncenter.MissionCenter)$" },
	float = true,
	size = { "monitor_w * 0.7", "monitor_h * 0.7" },
})
hl.window_rule({
	name = "kvantum-manager",
	match = { title = "(Kvantum Manager)" },
	float = true,
	size = { "monitor_w * 0.6", "monitor_h * 0.7" },
})
hl.window_rule({
	name = "qalculate",
	match = { class = "^([Qq]alculate-gtk)$" },
	float = true,
})
hl.window_rule({
	name = "pip",
	match = { title = "^(Picture-in-Picture)$" },
	float = true,
	size = { "monitor_w * 0.25", "monitor_h * 0.25" },
	pin = true,
})
hl.window_rule({
	name = "auth",
	match = { title = "^(Authentication Required)$" },
	float = true,
})

hl.layer_rule({
	name = "vicinae-blur",
	match = { namespace = "vicinae" },
	blur = true,
	ignore_alpha = 0,
})

hl.window_rule({
	match = { class = "flameshot" },
	no_anim = true,
	pin = true,
	float = true,
	decorate = false,
	no_blur = true,
	no_shadow = true,
})
hl.window_rule({
	match = { class = "flameshot", title = "flameshot" },
	move = { 0, 0 },
})
hl.window_rule({
	match = { class = "flameshot", title = "flameshot-pin" },
	move = { "cursor_x-(window_w*0.5)", "cursor_y-(window_h*0.5)" },
})
