# anti-slop provenance

- Source: `install-anti-slop` skill bundle, `modules/llm/skills/effect/install-anti-slop/assets/anti-slop/` in `github:mippbipp/skills`
- Skills commit: `682ac53ead8765b17109e31d4951a601a69fd99c`
- Installed with `scripts/install.mjs` as a fresh install, then moved under `hosts/pewter/flake-updater/tools/oxlint/anti-slop/`.
- Deviations: none. The sourdough template's local `packageAliases` option for `no-service-constructor-imports` was not carried over, since this project has no package aliases.
- `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.
