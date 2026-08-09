local function is_internal(m)
	return m.name:match("^eDP") or (m.description or ""):match("Built%-in")
end

local function apply_monitor(m)
	if is_internal(m) then
		H.internal = m.name
		hl.monitor({ output = m.name, mode = "preferred", position = "0x0", scale = 1.25 })
	else
		hl.monitor({ output = m.name, mode = "preferred", position = "auto", scale = 1 })
	end
end

-- applied on config reloads
for _, m in ipairs(hl.get_monitors()) do
	apply_monitor(m)
	if not is_internal(m) then
		hl.workspace_rule({ workspace = "1", monitor = m.name })
		hl.workspace_rule({ workspace = "2", monitor = m.name })
	end
end

-- only applied first time monitors are connected
hl.on("monitor.added", function(m)
	if not m then
		return
	end
	apply_monitor(m)
	if not is_internal(m) then
		hl.dispatch(hl.dsp.workspace.move({ workspace = 1, monitor = m.name }))
		hl.dispatch(hl.dsp.workspace.move({ workspace = 2, monitor = m.name }))
	end
end)
