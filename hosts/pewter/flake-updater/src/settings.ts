import type { Redacted } from "effect";
import { Context, Duration } from "effect";

export interface UpdaterSettings {
  /** Run repair rounds when the Build gate is red. */
  readonly agent: boolean;
  readonly maxRounds: number;
  /** Repair work stops and reports before the unit's hard timeout. */
  readonly deadline: Duration.Duration;
  /** The Flake fixer's workspace, outside the Updater's checkout. */
  readonly workDir: string;
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
  readonly repoDir: string;
  /** `owner/name` on GitHub. */
  readonly repo: string;
  readonly token: Redacted.Redacted;
  /** Read from GitHub, but never push, comment, or open anything. */
  readonly dryRun: boolean;
}

export class Host extends Context.Service<Host, HostConfig>()(
  "flake-updater/settings/Host"
) {}

export const defaultDeadline = Duration.minutes(11 * 60 + 30);
