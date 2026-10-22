import { Context, Layer } from "effect";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DgpuConfigService {
  readonly registryPath: string;
  readonly applicationsDir: string;
  readonly sourceDirs: ReadonlyArray<string>;
}

export interface DgpuConfigOverrides {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly registry?: string | undefined;
  readonly applicationsDir?: string | undefined;
  readonly sourceDirs?: ReadonlyArray<string> | undefined;
}

/**
 * Resolves the registry and XDG application directories. The generator keeps
 * the same defaults as the Python implementation so existing registries and
 * wrapper entries keep working.
 */
export const makeConfig = (overrides: DgpuConfigOverrides = {}): DgpuConfigService => {
  const env = overrides.env ?? process.env;
  const home = env.HOME || homedir();
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");

  const sourceDirs =
    overrides.sourceDirs ??
    (() => {
      const dirs = (env.XDG_DATA_DIRS ?? "")
        .split(":")
        .filter((dir) => dir.length > 0);
      for (const dir of ["/usr/local/share", "/usr/share"]) {
        if (!dirs.includes(dir)) {
          dirs.push(dir);
        }
      }
      return [...new Set(dirs)].map((dir) => join(dir, "applications"));
    })();

  return {
    registryPath: overrides.registry ?? join(configHome, "caelestia", "dgpu.json"),
    applicationsDir: overrides.applicationsDir ?? join(dataHome, "applications"),
    sourceDirs,
  };
};

export class DgpuConfig extends Context.Service<DgpuConfig, DgpuConfigService>()(
  "dgpu/DgpuConfig",
) {
  static readonly layer = Layer.sync(DgpuConfig, () => makeConfig());
}
