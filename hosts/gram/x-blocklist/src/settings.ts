import { Context } from "effect";

export interface BlocklistSettings {
  /** Read both lists and report the changes without sending any. */
  readonly dryRun: boolean;
  /** Random wait between block and unblock requests, in milliseconds. */
  readonly pause: { readonly min: number; readonly max: number };
}

export class Settings extends Context.Service<Settings, BlocklistSettings>()(
  "x-blocklist/settings"
) {}
