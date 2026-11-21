import { Context } from "effect";

export interface BlocklistSettings {
  /** Read both lists and report the changes without sending any. */
  readonly dryRun: boolean;
  /** Random wait between block and unblock requests, in milliseconds. */
  readonly pause: { readonly max: number; readonly min: number };
}

export class Settings extends Context.Service<Settings, BlocklistSettings>()(
  "x-blocklist/settings"
) {}
