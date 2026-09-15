# Research: profile `nrs` eval share (pewter host, gram config)

Question (wayfinder #218, parent map #217 "Instant-feel nrs map"): profile `nrs`
eval on gram (flamegraph + NIX_SHOW_STATS) — confirm eval share of the ~2min
wait before building anything. Backs `docs/research/instant-nixos-switch.md`
section 2.

Verdict: **confirmed — eval dominates the no-op/small-edit wait on both
hosts measured.** Pewter (local, aarch64): ~15s uncached eval vs ~0s
realize/substitute (no-op) vs seconds activation. Gram config (x86_64,
evaluated from pewter): ~38s uncached eval cpu (~74s wall cold with store
fetch) vs realize only on changes vs seconds activation. The ~2min `nrs` wait
is eval + substituter queries + activation; eval is the single largest share
and the only share present on every run.

## Provenance (so the numbers reproduce)

- Measured on host: **pewter** (ticket asked for gram; current host is pewter,
  so per ticket: profiled pewter natively + gram's config by read-only eval
  from pewter; host difference noted everywhere below).
- `hostname`: pewter. `nix --version`: nix (Nix) 2.34.8.
- Repo revision: `834643b`, branch `research/instant-switch` at measure time;
  tracked tree clean vs HEAD (`git status --short` showed only `?? docs/research/`
  untracked). Findings committed on throwaway branch `research/profile-nrs-eval`.
- Platforms: `nix eval '.#nixosConfigurations.gram.pkgs.hostPlatform.system'
  --raw` → `x86_64-linux`; pewter → `aarch64-linux`. Gram realize numbers are
  cross-arch (pewter store lacks x86_64 closures) and overstate on-gram realize;
  gram eval numbers are arch-independent and stand.
- Read-only profiling only: `nix eval`, `nix build --dry-run`, `nixos-rebuild
  dry-build`, `nix path-info`. **No generations switched, no Build gate bypass**
  (gate: `docs/agents/flake-update-pipeline.md` — builds every
  `nixosConfigurations.<host>` toplevel; untouched).
- `nom` (nix-output-monitor) is **not installed on pewter** (`which nom` →
  not found), so `-vvvv` + `NIX_SHOW_STATS=1` were used instead of `nom`.
- No decrypted secrets appear below (SOPS values never read; only public
  substituter URLs from `nix show-config`).

## 1. Eval: pewter (local host, warm store)

Exact commands, verbatim outputs (trimmed):

```sh
$ time nix eval '.#nixosConfigurations.pewter.config.system.build.toplevel' --no-write-lock-file
«derivation /nix/store/9fxb61vmvvbyx14ij6jyyycma38xh3rc-nixos-system-pewter-26.11.20260905.c043004.drv»
nix eval ...  12.48s user 1.56s system 90% cpu 15.474 total
```

```sh
$ NIX_SHOW_STATS=1 nix eval '.#nixosConfigurations.pewter.config.system.build.toplevel' --no-write-lock-file
«derivation /nix/store/9fxb61vmvvbyx14ij6jyyycma38xh3rc-nixos-system-pewter-26.11.20260905.c043004.drv»
{ "cpuTime": 13.82, "gc": { "cycles": 5, "heapSize": 990117888, "totalBytes": 1473085952 },
  "nrThunks": 14720262, "nrFunctionCalls": 8673159, "nrLookups": 5412295,
  "nrPrimOpCalls": 4308386, "nrOpUpdates": 1542360,
  "sets": { "number": 3309144, "elements": 37694338 },
  "time": { "cpu": 13.82, "gc": 1.507, "gcFraction": 0.109 } }
```

True uncached eval (bypasses eval cache):

```sh
$ time nix eval '.#nixosConfigurations.pewter.config.system.build.toplevel' --no-write-lock-file --option eval-cache false
«derivation /nix/store/9fxb61vmvvbyx14ij6jyyycma38xh3rc-nixos-system-pewter-26.11.20260905.c043004.drv»
nix eval ...  12.70s user 1.28s system 95% cpu 14.673 total
```

Eval cache effect (`eval-cache = true` in `nix show-config`): repeat eval
with cache hit drops to **0.08–0.24s** (`nix build --dry-run -vvvv`: 0.05s
user, 0.084 total, logs `using cached attrset attribute ...`). So every
cache-miss run pays ~15s; cache-hit runs pay ~0.1s. Dirty `git+file` trees
defeat this cache (cache explicitly skips dirty trees —
https://github.com/NixOS/nix/issues/10437), which is why `nrs` on a dirty
checkout feels the full ~15s (or worse) every time.

Primary-source frame: the evaluator is single-threaded for `toplevel`
(95–98% cpu on one core above; only `flake show/search` use threads) —
https://determinate.systems/blog/parallel-nix-eval/,
https://github.com/NixOS/nix/pull/10938; module system walks all
options/modules even for one-line changes —
https://discourse.nixos.org/t/slow-nixos-rebuild/48059,
tracking https://github.com/NixOS/nixpkgs/issues/57477; minimal-closure
baseline drift 0.4s→3s over releases —
https://discourse.nixos.org/t/a-look-at-nixos-nixpkgs-evaluation-times-over-the-years/65114.

## 2. Eval: gram config (from pewter, read-only)

```sh
$ time nix eval '.#nixosConfigurations.gram.config.system.build.toplevel' --no-write-lock-file
copying path '/nix/store/87acc3w303j54scj52mnaghwbf0mharj-base16-schemes-0-unstable-2026-01-15' from 'https://cache.nixos.org'...
«derivation /nix/store/isl1jqdsvn1qsipj4d09h76sc4hsq0nb-nixos-system-gram-26.11.20260905.c043004.drv»
nix eval ...  31.01s user 4.31s system 47% cpu 1:14.41 total
```

Note the 47% cpu: wall (74s) far exceeds cpu (35s) — the run interleaved
evaluation with store fetches (IFD/substitute during eval; IFD serializes
eval→build→eval, https://nix.dev/manual/nix/latest/language/import-from-derivation;
test with `--option allow-import-from-derivation false`).

Uncached eval cpu, warm store:

```sh
$ time NIX_SHOW_STATS=1 nix eval '.#nixosConfigurations.gram.config.system.build.toplevel' --no-write-lock-file --option eval-cache false
{ "cpuTime": 32.048, "gc": { "cycles": 7, "heapSize": 2198077440 },
  "nrThunks": 26631147, "nrFunctionCalls": 14395884, "nrLookups": 8565205,
  "nrPrimOpCalls": 7024790, "nrOpUpdates": 3272042,
  "sets": { "number": 5863674, "elements": 87057457 },
  "time": { "cpu": 32.048, "gc": 3.253, "gcFraction": 0.102 } }
NIX_SHOW_STATS=1 nix eval ...  32.07s user 3.33s system 94% cpu 37.620 total
```

Gram eval cpu (**32s**) is ~2.3× pewter (**13.8s**); thunks 26.6M vs 14.7M,
function calls 14.4M vs 8.7M, attrsets 5.9M vs 3.3M — gram's config (desktop:
nvidia/intel drivers, virtualization, theming; see `hosts/gram/config.nix`)
evaluates roughly twice the module/package graph.

## 3. Flamegraph: where eval time goes

`nix show-config` defaults on pewter: `eval-profiler = disabled`,
`eval-profile-file = nix.profile`. Ticket method used verbatim:

```sh
$ time NIX_SHOW_STATS=1 nix eval '.#nixosConfigurations.pewter.config.system.build.toplevel' \
    --no-write-lock-file --option eval-profiler flamegraph --option eval-profile-file /tmp/nix-profile-pewter
# wall 16.227 total (profiler overhead ~0.7s over the 15.5s baseline)
$ ls -lh /tmp/nix-profile-pewter   # 14M, folded-stack format
```

Top leaf frames, pewter (1345 samples):

| share | frame |
|---|---|
| 6.2% | `lib/modules.nix:707 applyModuleArgs` |
| 5.8% / 4.3% / 3.5% | `pkgs/stdenv/generic/make-derivation.nix:563 / :631 / :582` |
| 4.0% | `lib/trivial.nix:1109 primop functionArgs` |
| 3.0% / 2.6% / 1.9% | `make-derivation.nix:970 makeCMakeFlags / :542 optionals / :971 makeMesonFlags` |

Gram profile (37.2s wall, 43M file, 3188 samples) shows the same two
hotspots with a broader spread: `make-derivation.nix:563` 6.3%, `:631` 4.6%,
`:582` 4.3%, `functionArgs` 3.0%, `applyModuleArgs` 2.4%. Reading: the module
system (`modules.nix`, `attrsets.nix` recurse/mapAttrs/zipAttrsWith dominate
full stacks) plus per-package `make-derivation`IFDEF option plumbing. No
single option dominates — consistent with "the module system walks
everything" rather than one guilty module. Profiling how-to source:
https://discourse.nixos.org/t/profiling-optimising-nixos-configuration-derivation/75095.

## 4. Realize / substitute vs eval (separation)

Pewter no-op (everything already realized):

```sh
$ time nixos-rebuild dry-build --flake ".?submodules=1#pewter"
building the system configuration...
nixos-rebuild dry-build ...  12.91s user 1.30s system 96% cpu 14.745 total   # first: eval-dominated
$ time nixos-rebuild dry-build --flake ".?submodules=1#pewter" -v
building the system configuration...
nixos-rebuild dry-build ...  0.18s user 0.04s system 92% cpu 0.239 total     # cached: eval cache hit
$ time nix build '.#nixosConfigurations.pewter.config.system.build.toplevel' --dry-run --no-write-lock-file -vvvv
querying info about missing paths...
nix build ...  0.05s user 0.02s system 83% cpu 0.084 total                   # 0 missing paths
$ TOPLVL=$(nix eval '.#nixosConfigurations.pewter.config.system.build.toplevel' --no-write-lock-file --raw)
$ time nix path-info "$TOPLVL"        # 0.045 total — closure already realized (nar 356KB)
```

So pewter no-op: **eval ~15s / realize+substitute ~0s**. `dry-build` output
lists zero derivations to build — realize share is zero when nothing changed.

Gram from pewter (cross-arch — reads as an upper bound, not an on-gram
prediction):

```sh
$ time nix build '.#nixosConfigurations.gram.config.system.build.toplevel' --dry-run --no-write-lock-file
these 489 derivations will be built:
  /nix/store/0324813nfb0kip7cq7k4g7iyq4appxsb-hm_mpvscriptoptsmodernz.conf.drv
  ... (mostly tiny hm_*/unit text builders)
these 2409 paths will be fetched (5.0 GiB download, 30.8 GiB unpacked):
  ... (zoom, zsh, ... tail of 2900 total lines)
nix build ...  30.28s user 4.02s system 55% cpu 1:02.27 total
```

The 62s wall at 55% cpu is eval (~32s cpu) + querying **7 substituters**
(`nix show-config`: fleet, hyprland, winapps, vicinae, lantian, numtide,
cache.nixos.org — each queried on miss;
https://discourse.nixos.org/t/how-to-improve-nixos-rebuild-switch-speed/56496).
On gram itself most of the 2409 paths would already be realized or hit the
fleet Attic cache, so on-gram realize ≈ substitute time for deltas only, not
5 GiB. Method sources:
https://discourse.nixos.org/t/solution-for-slow-rebuilds-and-upgrades/58073,
https://discourse.nixos.org/t/why-my-nixos-rebuild-in-flake-doesnt-use-binary-cache/51449.
Remote builders offload build, never eval (55s-eval vs 8s-no-op example):
https://discourse.nixos.org/t/nixos-rebuild-delegate-everything-to-build-host/75874.

## 5. Activation (not measured — read-only constraint)

Deliberately not executed (would require `switch`/`test`/`boot` and a
generation link). By primary sources activation is **seconds**: `switch` is
build-toplevel → link profile → `result/bin/switch-to-configuration switch`
(https://wiki.nixos.org/wiki/Nixos-rebuild); the activation sequence
(stop → activate script → daemon-reexec → daemon-reload → reload/restart/start)
and its ordering constraints are in
https://raw.githubusercontent.com/NixOS/nixpkgs/master/nixos/doc/manual/development/what-happens-during-a-system-switch.chapter.md
and
https://github.com/NixOS/nixpkgs/blob/9ad22d35b67cf3bb03ffd56e96f38bcdbb9163a0/nixos/modules/system/activation/switch-to-configuration.pl.
`--fast`/`--no-build-nix` skips the rebuild-Nix reexec trap
(https://github.com/NixOS/nixpkgs/issues/384685).

## 6. Bottom line for the map

| phase | pewter no-op | gram (from pewter) |
|---|---|---|
| eval (uncached) | **~15s wall / 13.8s cpu** | **~38s wall / 32s cpu** (~74s cold w/ fetch) |
| eval (cache hit) | ~0.1–0.2s | ~0.1s (same mechanism) |
| realize/substitute (no-op) | **~0s** (0 missing paths) | cross-arch upper bound: 489 drvs + 2409 paths / 5 GiB; on-gram ≈ deltas only |
| activation | seconds (literature) | seconds (literature) |

Eval is confirmed as the dominant, always-paid share — 100% of the no-op
wait on pewter, ~60%+ of the gram cold wait before a single byte of the
closure is even questioned. This backs `instant-nixos-switch.md` §2 verbatim
and prioritizes that doc's §7 frontier items 1–2 (this profile; cheap eval
wins: `follows` audit, `inputs`-in-`specialArgs` trim, commit-before-switch
habit for eval cache, `--fast`, substituter trim) ahead of any backgrounding
work. Unfollowed-inputs and HM-as-module multipliers cited there
(https://discourse.nixos.org/t/how-can-i-speed-up-nixos-rebuild-switch/65775/1,
https://discourse.nixos.org/t/evaluating-derivation-getting-slow/49985,
https://discourse.nixos.org/t/how-to-improve-nixos-rebuild-switch-speed/56496)
were not re-measured here and remain the obvious next profiling targets
(e.g. `--option allow-import-from-derivation false` IFD test).
