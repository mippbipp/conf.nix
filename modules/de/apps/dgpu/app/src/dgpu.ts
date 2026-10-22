import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { DgpuConfig } from "./config.js";
import { wrapperFilename } from "./desktop.js";
import type { DgpuError } from "./errors.js";
import {
  applyRegistry,
  assignedDgpuIds,
  readRegistry,
  setAssignment,
  writeRegistry,
} from "./registry.js";

export interface DgpuService {
  readonly assigned: () => Effect.Effect<ReadonlySet<string>, DgpuError>;
  readonly reconcile: () => Effect.Effect<void, DgpuError>;
  readonly set: (entryId: string, on: boolean) => Effect.Effect<void, DgpuError>;
  readonly wrapperPath: (entryId: string) => string;
}

/**
 * Filesystem-backed dGPU domain service. The Vicinae command and the CLI both
 * use this service, so there is one implementation of the registry and wrapper
 * rules.
 */
export class Dgpu extends Context.Service<Dgpu, DgpuService>()("dgpu/Dgpu") {
  static readonly layer = Layer.effect(
    Dgpu,
    Effect.gen(function* () {
      const config = yield* DgpuConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const assigned = Effect.fn("Dgpu.assigned")(function* () {
        const registry = yield* readRegistry(fs, config.registryPath);
        return assignedDgpuIds(registry);
      });

      const reconcile = Effect.fn("Dgpu.reconcile")(function* () {
        const registry = yield* readRegistry(fs, config.registryPath);
        yield* applyRegistry(fs, path, config, registry);
      });

      const set = Effect.fn("Dgpu.set")(function* (entryId: string, on: boolean) {
        const registry = yield* readRegistry(fs, config.registryPath);
        const next = setAssignment(registry, entryId, on);
        if (next.changed) {
          yield* writeRegistry(fs, path, config.registryPath, next.registry);
        }
        yield* applyRegistry(fs, path, config, next.registry);
      });

      return Dgpu.of({
        assigned,
        reconcile,
        set,
        wrapperPath: (entryId) =>
          path.join(config.applicationsDir, wrapperFilename(entryId)),
      });
    }),
  );
}
