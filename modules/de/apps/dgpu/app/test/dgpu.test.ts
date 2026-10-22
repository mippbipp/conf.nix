import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DgpuConfig, makeConfig } from "../src/config.js";
import { wrapperFilename } from "../src/desktop.js";
import { Dgpu } from "../src/dgpu.js";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const FIXTURE_SOURCE = join(FIXTURES, "source");
const FIXTURE_REGISTRY = join(FIXTURES, "registry");
const FIXTURE_EXPECTED = join(FIXTURES, "expected");

const OFFLOAD_PREFIX =
  "env __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia __VK_LAYER_NV_optimus=NVIDIA_only";

interface HarnessOptions {
  readonly registryFixture?: string | undefined;
  readonly registrySubpath?: string | undefined;
}

const makeHarness = Effect.fn("makeHarness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "dgpu-test-" });
  const applicationsDir = path.join(root, "applications");
  const sourceDir = path.join(root, "source");
  const registryPath = path.join(root, options.registrySubpath ?? "dgpu.json");

  yield* fs.makeDirectory(applicationsDir, { recursive: true });
  yield* fs.makeDirectory(sourceDir, { recursive: true });
  for (const name of yield* fs.readDirectory(FIXTURE_SOURCE)) {
    yield* fs.copyFile(path.join(FIXTURE_SOURCE, name), path.join(sourceDir, name));
  }
  if (options.registryFixture !== undefined) {
    yield* fs.copyFile(
      path.join(FIXTURE_REGISTRY, options.registryFixture),
      registryPath,
    );
  }

  const config = makeConfig({
    registry: registryPath,
    applicationsDir,
    sourceDirs: [sourceDir],
  });
  const layer = Dgpu.layer.pipe(
    Layer.provide(Layer.succeed(DgpuConfig, config)),
  );
  const run = <A, E>(program: Effect.Effect<A, E, Dgpu>) =>
    program.pipe(Effect.provide(layer));

  return {
    fs,
    path,
    root,
    applicationsDir,
    sourceDir,
    registryPath,
    config,
    run,
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const wrapperPath = (harness: Harness, entryId: string): string =>
  harness.path.join(harness.applicationsDir, wrapperFilename(entryId));

const readText = (harness: Harness, filePath: string) =>
  harness.fs.readFileString(filePath);

const readJson = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>;

const reconcile = (harness: Harness) =>
  harness.run(
    Effect.gen(function* () {
      const dgpu = yield* Dgpu;
      yield* dgpu.reconcile();
    }),
  );

const setDgpu = (harness: Harness, entryId: string, on: boolean) =>
  harness.run(
    Effect.gen(function* () {
      const dgpu = yield* Dgpu;
      yield* dgpu.set(entryId, on);
    }),
  );

const failureMessage = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<string, never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error.message,
      onSuccess: () => "",
    }),
  );

const directoryEntries = (harness: Harness, directory: string) =>
  Effect.gen(function* () {
    const names = yield* harness.fs.readDirectory(directory);
    return [...names].sort();
  });

const directoryText = (harness: Harness, directory: string) =>
  Effect.gen(function* () {
    const names = yield* directoryEntries(harness, directory);
    const entries: Record<string, string> = {};
    for (const name of names) {
      entries[name] = yield* readText(harness, harness.path.join(directory, name));
    }
    return entries;
  });

it.layer(NodeServices.layer)("dGPU", (it) => {
  it.effect("creates wrappers with the offload exec for assigned apps", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      yield* reconcile(harness);

      assert.strictEqual(
        yield* readText(harness, wrapperPath(harness, "com.visualstudio.code.desktop")),
        yield* readText(
          harness,
          join(FIXTURE_EXPECTED, "com.visualstudio.code (dGPU).desktop"),
        ),
      );
      assert.strictEqual(
        yield* readText(harness, wrapperPath(harness, "com.valvesoftware.Steam.desktop")),
        yield* readText(
          harness,
          join(FIXTURE_EXPECTED, "com.valvesoftware.Steam (dGPU).desktop"),
        ),
      );
    }),
  );

  it.effect("matches the golden wrapper content", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });
      yield* reconcile(harness);

      const golden = yield* readText(
        harness,
        join(FIXTURE_EXPECTED, "com.visualstudio.code (dGPU).desktop"),
      );
      assert.strictEqual(
        yield* readText(harness, wrapperPath(harness, "com.visualstudio.code.desktop")),
        golden,
      );
      assert.include(golden, `Exec=${OFFLOAD_PREFIX} code %U`);
      assert.include(golden, "Name=Visual Studio Code (dGPU)");
      assert.include(golden, "X-Caelestia-DGPU-Source=com.visualstudio.code.desktop");
    }),
  );

  it.effect("leaves desktop action groups untouched", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      yield* reconcile(harness);

      const content = yield* readText(
        harness,
        wrapperPath(harness, "com.valvesoftware.Steam.desktop"),
      );
      assert.include(content, "Name=Store");
      assert.include(content, "Exec=steam steam://store");
      assert.notInclude(content, "Store (dGPU)");
    }),
  );

  it.effect("is idempotent on a rerun", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      yield* reconcile(harness);
      const before = yield* directoryText(harness, harness.applicationsDir);

      yield* reconcile(harness);
      const after = yield* directoryText(harness, harness.applicationsDir);

      assert.deepStrictEqual(after, before);
    }),
  );

  it.effect("removes a wrapper when its app is no longer assigned", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      yield* reconcile(harness);
      yield* harness.fs.copyFile(
        join(FIXTURE_REGISTRY, "one-app.json"),
        harness.registryPath,
      );
      yield* reconcile(harness);

      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.visualstudio.code.desktop"),
        ),
      );
      assert.isFalse(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.valvesoftware.Steam.desktop"),
        ),
      );
    }),
  );

  it.effect("leaves unrelated desktop entries untouched", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      const unrelated = harness.path.join(
        harness.applicationsDir,
        "org.gimp.GIMP.desktop",
      );
      const original = "[Desktop Entry]\nName=GIMP\nExec=gimp %U\n";
      yield* harness.fs.writeFileString(unrelated, original);
      yield* reconcile(harness);
      assert.strictEqual(yield* readText(harness, unrelated), original);
    }),
  );

  it.effect("does nothing when the registry is missing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* reconcile(harness);
      assert.deepStrictEqual(
        yield* directoryEntries(harness, harness.applicationsDir),
        [],
      );
    }),
  );

  it.effect("reports an invalid registry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "invalid.json" });
      const message = yield* failureMessage(reconcile(harness));
      assert.include(message, "cannot read registry");
    }),
  );

  it.effect("removes a stale wrapper when the source disappears", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "none.json" });
      const stale = wrapperPath(harness, "com.visualstudio.code.desktop");
      yield* harness.fs.writeFileString(
        stale,
        "[Desktop Entry]\nX-Caelestia-DGPU-Source=com.visualstudio.code.desktop\nName=Code\n",
      );
      yield* reconcile(harness);
      assert.isFalse(yield* harness.fs.exists(stale));
    }),
  );

  it.effect("prefers the user applications directory over XDG sources", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });
      yield* harness.fs.writeFileString(
        harness.path.join(harness.applicationsDir, "com.visualstudio.code.desktop"),
        "[Desktop Entry]\nName=Code\nExec=/opt/code/code %U\n",
      );
      yield* reconcile(harness);
      const content = yield* readText(
        harness,
        wrapperPath(harness, "com.visualstudio.code.desktop"),
      );
      assert.include(content, `Exec=${OFFLOAD_PREFIX} /opt/code/code %U`);
    }),
  );

  it.effect("does not double-wrap an existing env prefix", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });
      yield* harness.fs.writeFileString(
        harness.path.join(harness.sourceDir, "com.visualstudio.code.desktop"),
        "[Desktop Entry]\nName=Code\nExec=env FOO=1 code %U\n",
      );
      yield* reconcile(harness);
      const content = yield* readText(
        harness,
        wrapperPath(harness, "com.visualstudio.code.desktop"),
      );
      assert.include(content, `Exec=${OFFLOAD_PREFIX} FOO=1 code %U`);
      assert.strictEqual(content.split("env ").length - 1, 1);
    }),
  );

  it.effect("builds wrapper filenames from desktop ids", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        wrapperFilename("com.visualstudio.code.desktop"),
        "com.visualstudio.code (dGPU).desktop",
      );
      assert.strictEqual(wrapperFilename("myapp"), "myapp (dGPU).desktop");
    }),
  );

  it.effect("only owns markers in the main desktop group", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "none.json" });
      const foreign = harness.path.join(
        harness.applicationsDir,
        "Other (dGPU).desktop",
      );
      yield* harness.fs.writeFileString(
        foreign,
        "[Desktop Entry]\nName=Other\nExec=other\n\n[Desktop Action X]\nX-Caelestia-DGPU-Source=com.visualstudio.code.desktop\n",
      );
      yield* reconcile(harness);
      assert.isTrue(yield* harness.fs.exists(foreign));
    }),
  );

  it.effect("ignores non-dGPU assignments", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fs.writeFileString(
        harness.registryPath,
        '{"apps": {"com.visualstudio.code.desktop": "iGPU"}}',
      );
      yield* reconcile(harness);
      assert.deepStrictEqual(
        yield* directoryEntries(harness, harness.applicationsDir),
        [],
      );
    }),
  );

  it.effect("set on writes the registry and creates the wrapper", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      yield* setDgpu(harness, "org.mozilla.firefox.desktop", true);

      const data = readJson(yield* readText(harness, harness.registryPath));
      assert.deepStrictEqual(data["apps"], {
        "com.visualstudio.code.desktop": "dGPU",
        "com.valvesoftware.Steam.desktop": "dGPU",
        "org.mozilla.firefox.desktop": "dGPU",
      });
      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "org.mozilla.firefox.desktop"),
        ),
      );
    }),
  );

  it.effect("set on is idempotent and does not rewrite the registry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      yield* setDgpu(harness, "org.mozilla.firefox.desktop", true);

      const contentBefore = yield* readText(harness, harness.registryPath);
      const statBefore = yield* harness.fs.stat(harness.registryPath);
      yield* setDgpu(harness, "org.mozilla.firefox.desktop", true);
      const contentAfter = yield* readText(harness, harness.registryPath);
      const statAfter = yield* harness.fs.stat(harness.registryPath);

      assert.strictEqual(contentAfter, contentBefore);
      assert.strictEqual(
        Option.getOrThrow(statAfter.ino),
        Option.getOrThrow(statBefore.ino),
      );
      assert.strictEqual(
        Option.getOrThrow(statAfter.mtime).getTime(),
        Option.getOrThrow(statBefore.mtime).getTime(),
      );
    }),
  );

  it.effect("set off removes the assignment and the wrapper", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      yield* setDgpu(harness, "com.valvesoftware.Steam.desktop", false);

      const data = readJson(yield* readText(harness, harness.registryPath));
      assert.deepStrictEqual(data["apps"], {
        "com.visualstudio.code.desktop": "dGPU",
      });
      assert.isFalse(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.valvesoftware.Steam.desktop"),
        ),
      );
      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.visualstudio.code.desktop"),
        ),
      );
    }),
  );

  it.effect("set off for an unassigned app is a no-op", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });
      const before = yield* readText(harness, harness.registryPath);
      yield* setDgpu(harness, "com.valvesoftware.Steam.desktop", false);
      assert.strictEqual(yield* readText(harness, harness.registryPath), before);
    }),
  );

  it.effect("set on creates a missing registry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* setDgpu(harness, "com.visualstudio.code.desktop", true);
      const data = readJson(yield* readText(harness, harness.registryPath));
      assert.deepStrictEqual(data["apps"], {
        "com.visualstudio.code.desktop": "dGPU",
      });
      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.visualstudio.code.desktop"),
        ),
      );
    }),
  );

  it.effect("set on creates missing registry parent directories", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        registrySubpath: "config/caelestia/dgpu.json",
      });
      yield* setDgpu(harness, "com.visualstudio.code.desktop", true);
      const data = readJson(yield* readText(harness, harness.registryPath));
      assert.deepStrictEqual(data["apps"], {
        "com.visualstudio.code.desktop": "dGPU",
      });
      assert.isTrue(
        yield* harness.fs.exists(
          wrapperPath(harness, "com.visualstudio.code.desktop"),
        ),
      );
    }),
  );

  it.effect("set preserves other entries and extra keys", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "two-apps.json" });
      const initial = readJson(yield* readText(harness, harness.registryPath));
      initial["gpus"] = { primary: "iGPU" };
      yield* harness.fs.writeFileString(
        harness.registryPath,
        JSON.stringify(initial),
      );

      yield* setDgpu(harness, "org.mozilla.firefox.desktop", true);
      const after = readJson(yield* readText(harness, harness.registryPath));
      assert.deepStrictEqual(after["gpus"], { primary: "iGPU" });
      assert.deepStrictEqual(
        Object.keys(after["apps"] as Record<string, unknown>).sort(),
        [
          "com.valvesoftware.Steam.desktop",
          "com.visualstudio.code.desktop",
          "org.mozilla.firefox.desktop",
        ],
      );
    }),
  );

  it.effect("set reports an invalid registry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "invalid.json" });
      const message = yield* failureMessage(
        setDgpu(harness, "org.mozilla.firefox.desktop", true),
      );
      assert.include(message, "cannot read registry");
    }),
  );

  it.effect("set rejects a registry whose apps value is not an object", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fs.writeFileString(harness.registryPath, '{"apps": 42}');
      const message = yield* failureMessage(
        setDgpu(harness, "org.mozilla.firefox.desktop", true),
      );
      assert.include(message, "'apps' must be an object");
    }),
  );

  it.effect("set on an unresolvable source writes the registry only", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* setDgpu(harness, "org.only.ghost.desktop", true);
      const data = readJson(yield* readText(harness, harness.registryPath));
      assert.deepStrictEqual(data["apps"], {
        "org.only.ghost.desktop": "dGPU",
      });
      assert.isFalse(
        yield* harness.fs.exists(
          wrapperPath(harness, "org.only.ghost.desktop"),
        ),
      );
    }),
  );

  it.effect("set writes indented JSON with a trailing newline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registryFixture: "one-app.json" });
      yield* setDgpu(harness, "org.mozilla.firefox.desktop", true);
      const text = yield* readText(harness, harness.registryPath);
      assert.isTrue(text.endsWith("\n"));
      assert.include(text, '\n  "apps": {');
    }),
  );

  it.effect("set handles a registry without an apps key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fs.writeFileString(
        harness.registryPath,
        '{"gpus": {"primary": "iGPU"}}',
      );
      yield* setDgpu(harness, "com.visualstudio.code.desktop", true);
      const data = readJson(yield* readText(harness, harness.registryPath));
      assert.deepStrictEqual(data["gpus"], { primary: "iGPU" });
      assert.deepStrictEqual(data["apps"], {
        "com.visualstudio.code.desktop": "dGPU",
      });
    }),
  );
});
