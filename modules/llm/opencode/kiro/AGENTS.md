# Kiro OpenCode plugin

This directory is an Effect plugin. Before writing Effect code
there, run `BUN_BE_BUN=1 opencode install` in this directory, then read
`node_modules/effect/AGENTS.md` completely and follow its links when needed.
For APIs it doesn't cover, search `node_modules/effect/src`.

## Layout

- `src/` holds what OpenCode loads, and nothing else: `index.ts` (the server
  part) and the modules it imports, each named for what it owns, `rpc.ts`
  (the RPC between it and the sidebar) and `tui.tsx` (the sidebar).
  `modules/llm/opencode/app.nix` installs `src/` as it is to
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
  Schema helper and `send`).
- `test/plugin.test.ts` tests the server part through `src/index.ts`'s
  `_internal` export; `test/<module>.test.ts` tests a module of `src/`
  through its exports. `test/signin.ts` gives a test file a throwaway HOME
  and writes kiro-cli's and the IDE's sign-ins into it; `test/eventstream.ts`
  builds Kiro's event stream messages and reads SSE back; `test/messages.ts`
  holds Messages requests and PNGs several test files use.
- The dev config stays outside `src/`: `package.json`, `tsconfig.json`,
  `oxlint.config.ts`, `oxfmt.config.ts`, `bun.lock`, and the vendored
  anti-slop lint plugin in `tools/oxlint/anti-slop` (see its `UPSTREAM.md`).

At runtime OpenCode supplies `effect` and `@opencode/plugin` itself, so
`src/index.ts`, its modules and `src/rpc.ts` import only those, `bun:*`,
`node:*` and files in `src/`. `src/tui.tsx` may also import `solid-js` and
`@opentui/*`. The `no-restricted-imports` rule in `oxlint.config.ts` fails
lint on any other.

## Commands

`bun` isn't on PATH, so run Bun through opencode, in this directory:

- `BUN_BE_BUN=1 opencode install` installs the dev dependencies. Its
  `prepare` script patches tsc and oxlint with the Effect language service.
- `BUN_BE_BUN=1 opencode test` runs the tests.
- `BUN_BE_BUN=1 opencode run ox` checks formatting (oxfmt), lints (oxlint,
  type-aware, warnings fail) and typechecks (tsc). Run it before committing.
- `BUN_BE_BUN=1 opencode run ox:fix` formats, applies lint fixes, then
  typechecks. Read the diff afterwards: some lint fixes change code.
- `lint`, `lint:fix`, `format`, `format:fix` and `typecheck` run one step each.

A lint rule that doesn't fit this plugin is turned off in `oxlint.config.ts`
with a one-line reason beside it.
