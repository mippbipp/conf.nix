local function is_internal(m)
	return m.name:match("^eDP") or (m.description or ""):match("Built%-in")
end

for _, m in ipairs(hl.get_monitors()) do
	if is_internal(m) then
		H.internal = m.name
		hl.monitor({ output = m.name, mode = "preferred", position = "0x0", scale = 1.25 })
	else
		hl.monitor({ output = m.name, mode = "preferred", position = "auto", scale = 1 })
	end
end

if H.internal == nil then
	hl.monitor({ output = "", mode = "preferred", position = "auto", scale = "auto" })
end

local external
for _, m in ipairs(hl.get_monitors()) do
	if not is_internal(m) then
		external = external or m
	end
end

if external then
	hl.workspace_rule({ workspace = "1", monitor = external.name })
	hl.workspace_rule({ workspace = "2", monitor = external.name })
end

hl.on("monitor.added", function(m)
	if m and not is_internal(m) then
		hl.dsp.workspace.move({ workspace = 1, monitor = m.name })
		hl.dsp.workspace.move({ workspace = 2, monitor = m.name })
	end
end)
