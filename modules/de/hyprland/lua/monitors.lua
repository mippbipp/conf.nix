local function is_internal(m)
	return m.name:match("^eDP") or (m.description or ""):match("Built%-in")
end

local function apply_monitor_spec(m)
	if is_internal(m) then
		H.internal = m.name
		hl.monitor({ output = m.name, mode = "preferred", position = "0x0", scale = 1.25 })
	else
		hl.monitor({ output = m.name, mode = "preferred", position = "auto", scale = 1 })
	end
end

local function bind_workspaces(monitor_name)
	hl.workspace_rule({ workspace = "1", monitor = monitor_name })
	hl.workspace_rule({ workspace = "2", monitor = monitor_name })
end

local function external_monitor_name()
	for _, m in ipairs(hl.get_monitors()) do
		if not is_internal(m) then
			return m.name
		end
	end
end

-- applied on config reloads
for _, m in ipairs(hl.get_monitors()) do
	apply_monitor_spec(m)
end
local m_name = external_monitor_name()
if m_name then
	bind_workspaces(m_name)
end

-- applied when monitors are connected
hl.on("monitor.added", function(m)
	if not m or not m.name then
		return
	end
	apply_monitor_spec(m)
	if is_internal(m) then
		return
	end
	-- Keep workspaces on the first external monitor; ignore later externals.
	for _, existing in ipairs(hl.get_monitors()) do
		if existing.name ~= m.name and not is_internal(existing) then
			return
		end
	end
	bind_workspaces(m.name)
end)
