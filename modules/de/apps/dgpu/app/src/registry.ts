import { Effect, FileSystem, Path, Schema } from "effect";
import type { DgpuConfigService } from "./config.js";
import {
  DGPU,
  DESKTOP_EXT,
  WRAPPER_SUFFIX,
  buildWrapper,
  wrapperFilename,
  wrapperSourceId,
} from "./desktop.js";
import { DgpuError } from "./errors.js";

export interface Registry {
  readonly apps: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface RegistryChange {
  readonly registry: Registry;
  readonly changed: boolean;
}

const RegistryObject = Schema.Record(Schema.String, Schema.Unknown);

const parseError = (registryPath: string, cause: { readonly message: string }): DgpuError =>
  new DgpuError({
    message: `cannot read registry ${registryPath}: ${cause.message}`,
    cause,
  });

const writeError = (registryPath: string, cause: { readonly message: string }): DgpuError =>
  new DgpuError({
    message: `cannot write registry ${registryPath}: ${cause.message}`,
    cause,
  });

export const emptyRegistry = (): Registry => ({ apps: {} });

export const assignedDgpuIds = (registry: Registry): ReadonlySet<string> =>
  new Set(
    Object.entries(registry.apps)
      .filter(([, gpu]) => gpu === DGPU)
      .map(([entryId]) => entryId),
  );

export const setAssignment = (
  registry: Registry,
  entryId: string,
  on: boolean,
): RegistryChange => {
  const apps = { ...registry.apps };
  if (on) {
    if (apps[entryId] === DGPU) {
      return { registry, changed: false };
    }
    apps[entryId] = DGPU;
    return { registry: { ...registry, apps }, changed: true };
  }
  if (!(entryId in apps)) {
    return { registry, changed: false };
  }
  delete apps[entryId];
  return { registry: { ...registry, apps }, changed: true };
};

export const readRegistry = Effect.fn("readRegistry")(function* (
  fs: FileSystem.FileSystem,
  registryPath: string,
) {
  const exists = yield* fs
    .exists(registryPath)
    .pipe(Effect.mapError((cause) => parseError(registryPath, cause)));
  if (!exists) {
    return emptyRegistry();
  }

  const text = yield* fs
    .readFileString(registryPath)
    .pipe(Effect.mapError((cause) => parseError(registryPath, cause)));

  const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError((cause) => parseError(registryPath, cause)),
  );

  const raw = yield* Schema.decodeUnknownEffect(RegistryObject)(json).pipe(
    Effect.mapError((cause) => parseError(registryPath, cause)),
  );

  const rawApps = raw["apps"];
  if (rawApps === undefined) {
    return { ...raw, apps: {} };
  }

  const apps = yield* Schema.decodeUnknownEffect(RegistryObject)(rawApps).pipe(
    Effect.mapError(
      () =>
        new DgpuError({
          message: "registry key 'apps' must be an object",
        }),
    ),
  );

  return { ...raw, apps };
});

export const writeRegistry = Effect.fn("writeRegistry")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  registryPath: string,
  registry: Registry,
) {
  const text = `${JSON.stringify(registry, null, 2)}\n`;

  const exists = yield* fs
    .exists(registryPath)
    .pipe(Effect.mapError((cause) => writeError(registryPath, cause)));
  if (exists) {
    const current = yield* fs
      .readFileString(registryPath)
      .pipe(Effect.mapError((cause) => writeError(registryPath, cause)));
    if (current === text) {
      return;
    }
  }

  const directory = path.dirname(registryPath);
  const temporary = `${registryPath}.tmp`;
  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError((cause) => writeError(registryPath, cause)));
  yield* fs
    .writeFileString(temporary, text)
    .pipe(Effect.mapError((cause) => writeError(registryPath, cause)));
  yield* fs
    .rename(temporary, registryPath)
    .pipe(Effect.mapError((cause) => writeError(registryPath, cause)));
});

const statIfFile = Effect.fn("statIfFile")(function* (
  fs: FileSystem.FileSystem,
  candidate: string,
) {
  const info = yield* fs.stat(candidate).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(null)
        : Effect.fail(
            new DgpuError({
              message: `cannot inspect ${candidate}: ${cause.message}`,
              cause,
            }),
          ),
    ),
  );
  return info !== null && info.type === "File" ? info : null;
});

export const findSource = Effect.fn("findSource")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: DgpuConfigService,
  entryId: string,
) {
  for (const base of [config.applicationsDir, ...config.sourceDirs]) {
    const candidate = path.join(base, entryId);
    const info = yield* statIfFile(fs, candidate);
    if (info !== null) {
      return candidate;
    }
  }
  return undefined;
});

const readText = Effect.fn("readText")(function* (
  fs: FileSystem.FileSystem,
  filePath: string,
) {
  return yield* fs
    .readFileString(filePath)
    .pipe(
      Effect.mapError(
        (cause) =>
          new DgpuError({
            message: `cannot read ${filePath}: ${cause.message}`,
            cause,
          }),
      ),
    );
});

const writeText = Effect.fn("writeText")(function* (
  fs: FileSystem.FileSystem,
  filePath: string,
  contents: string,
) {
  yield* fs
    .writeFileString(filePath, contents)
    .pipe(
      Effect.mapError(
        (cause) =>
          new DgpuError({
            message: `cannot write ${filePath}: ${cause.message}`,
            cause,
          }),
      ),
    );
});

export const applyRegistry = Effect.fn("applyRegistry")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: DgpuConfigService,
  registry: Registry,
) {
  const desired = assignedDgpuIds(registry);
  const resolved = new Map<string, string | undefined>();

  for (const entryId of desired) {
    resolved.set(entryId, yield* findSource(fs, path, config, entryId));
  }

  yield* fs
    .makeDirectory(config.applicationsDir, { recursive: true })
    .pipe(
      Effect.mapError(
        (cause) =>
          new DgpuError({
            message: `cannot create ${config.applicationsDir}: ${cause.message}`,
            cause,
          }),
      ),
    );

  for (const [entryId, source] of resolved) {
    if (source === undefined) {
      continue;
    }
    const target = path.join(config.applicationsDir, wrapperFilename(entryId));
    const contents = buildWrapper(yield* readText(fs, source), entryId);

    const exists = yield* fs
      .exists(target)
      .pipe(
        Effect.mapError(
          (cause) =>
            new DgpuError({
              message: `cannot inspect ${target}: ${cause.message}`,
              cause,
            }),
        ),
      );
    if (exists) {
      const current = yield* readText(fs, target);
      if (current === contents) {
        continue;
      }
    }
    yield* writeText(fs, target, contents);
  }

  const names = yield* fs
    .readDirectory(config.applicationsDir)
    .pipe(
      Effect.mapError(
        (cause) =>
          new DgpuError({
            message: `cannot list ${config.applicationsDir}: ${cause.message}`,
            cause,
          }),
      ),
    );

  for (const name of names) {
    if (!name.endsWith(`${WRAPPER_SUFFIX}${DESKTOP_EXT}`)) {
      continue;
    }
    const target = path.join(config.applicationsDir, name);
    const info = yield* statIfFile(fs, target);
    if (info === null) {
      continue;
    }
    const sourceId = wrapperSourceId(yield* readText(fs, target));
    if (sourceId === undefined) {
      continue;
    }
    const source = resolved.get(sourceId);
    if (!resolved.has(sourceId) || source === undefined) {
      yield* fs.remove(target, { force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new DgpuError({
              message: `cannot remove ${target}: ${cause.message}`,
              cause,
            }),
        ),
      );
    }
  }
});
