import type { Redacted } from "effect";
import { Context, Duration } from "effect";

export interface UpdaterSettings {
  /** Repair work stops and reports before the unit's hard timeout. */
  readonly deadline: Duration.Duration;
  readonly maxRounds: number;
  /** Model the Flake fixer runs on, named in failure issues. */
  readonly model: string;
  /** Where a person can open a session, e.g. the tailnet web UI. */
  readonly sessionUrl: string;
}

export class Settings extends Context.Service<Settings, UpdaterSettings>()(
  "flake-updater/settings"
) {}

/** Machine facts the live layers need; the program never reads these. */
export interface HostConfig {
  /** Read from GitHub, but never push, comment, or open anything. */
  readonly dryRun: boolean;
  /** `owner/name` on GitHub. */
  readonly repo: string;
  readonly repoDir: string;
  readonly token: Redacted.Redacted;
}

export class Host extends Context.Service<Host, HostConfig>()(
  "flake-updater/settings/Host"
) {}

export const defaultDeadline = Duration.minutes(11 * 60 + 30);
