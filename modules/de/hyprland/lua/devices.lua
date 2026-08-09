hl.bind("switch:on:Lid Switch", function()
	hl.dsp.exec_cmd("pidof hyprlock || hyprlock -q")
	if H.internal then
		hl.monitor({ output = H.internal, disabled = true })
	end
end, { locked = true })

hl.bind("switch:off:Lid Switch", function()
	if H.internal then
		hl.monitor({ output = H.internal, mode = "preferred", position = "0x0", scale = 1.25 })
	end
end, { locked = true })
