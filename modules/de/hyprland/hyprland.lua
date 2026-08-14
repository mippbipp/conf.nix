local H = {
	mod = "SUPER",
}
H.env = require("env")
_G.H = H

require("lua.monitors")
require("lua.devices")
require("lua.ui")
require("lua.rules")
require("lua.keybinds")
