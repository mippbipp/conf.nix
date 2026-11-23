# Kiro OpenCode plugin

This directory is an Effect plugin and a package of the root Bun workspace
(see ADR 0022). Before writing Effect code here, read
`node_modules/effect/AGENTS.md` at the repo root completely and follow its
links when needed. For APIs it doesn't cover, search
`node_modules/effect/src`.

## Layout

- `src/` holds what OpenCode loads, and nothing else: `index.ts` (the server
  part) and the modules it imports, each named for what it owns, `rpc.ts`
  (the RPC between it and the sidebar) and `tui.tsx` (the sidebar).
  `package.nix` runs the checks and outputs `src/`, and
  `modules/llm/opencode/app.nix` installs that to
  `~/.config/opencode/plugins/kiro`, where OpenCode finds the parts by file
  name. Bun strips the types and there is no bundler.
- The modules so far: `account.ts` (the kiro-cli or IDE sign-in, its
  refresh, and Kiro's management API, behind the `KiroAccount` service),
  `conversation.ts` (one turn translated both ways: `open` turns a Messages
  request into the Kiro request and the reader of Kiro's event stream),
  `images.ts` (images over Kiro's size limit, behind the `Images` service),
  `models.ts` (the model catalogue and how each model thinks),
  `usage.ts` (the account's usage and each session's credits, which it
  answers the sidebar's RPC with),
  `failure.ts` (what OpenCode is told when a request fails) and `kiro.ts`
  (what several modules share: the provider id, the timeouts, the `field`
  Schema helper, `isOk`, `isSet`, `send` and `deadline`). `sidebar.ts` is the
  sidebar's view as plain data (whose credits a session counts, whether the
  section shows, its lines), so `tui.tsx` only asks, subscribes and draws.
- `test/plugin.test.ts` tests the server part through `src/index.ts`'s
  `internal` export; `test/<module>.test.ts` tests a module of `src/`
  through its exports. `test/signin.ts` gives a test file a throwaway HOME
  and writes kiro-cli's and the IDE's sign-ins into it; `test/eventstream.ts`
  builds Kiro's event stream messages and reads SSE back; `test/messages.ts`
  holds Messages requests and PNGs several test files use.

At runtime OpenCode supplies `effect` and `@opencode/plugin` itself, so
`src/index.ts`, its modules and `src/rpc.ts` import only those, `bun:*`,
`node:*` and files in `src/`. `src/tui.tsx` may also import `solid-js` and
`@opentui/*`. The dev dependencies in `package.json` are pinned to the
versions the installed OpenCode ships. An override for `src/` in the root
`oxlint.config.ts` fails lint on any other import. OpenCode provides no
FileSystem, Path or ChildProcess layer, so `src/` uses Node's modules and
reads HOME and PATH from `process.env`.

## Commands

Run these in this directory:

- `bun run test` runs the tests with `@effect/vitest`.
- `bun run typecheck` typechecks.

`bun run ox` and `bun run ox:fix` at the repo root lint, format and
typecheck every package, this one included. Read the diff after `ox:fix`:
some lint fixes change code. Object key sorting changes the order of keys in
JSON the plugin sends.
