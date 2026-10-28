# Kiro OpenCode plugin

This directory is an Effect plugin. Before writing Effect code
there, run `BUN_BE_BUN=1 opencode install` in this directory, then read
`node_modules/effect/AGENTS.md` completely and follow its links when needed.
For APIs it doesn't cover, search `node_modules/effect/src`. At runtime
OpenCode supplies `effect` and `@opencode/plugin` itself, so the plugin
imports only those, `bun:*` and `node:*` modules.
