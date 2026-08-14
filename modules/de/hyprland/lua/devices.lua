hl.bind("switch:on:Lid Switch", function()
	hl.exec_cmd("caelestia shell lock lock")
	if H.internal then
		hl.monitor({ output = H.internal, disabled = true })
	end
end, { locked = true })

hl.bind("switch:off:Lid Switch", function()
	if H.internal then
		hl.monitor({ output = H.internal, disabled = false })
	end
end, { locked = true })
