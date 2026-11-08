import { Effect, Layer, Option } from "effect";

import { run } from "./blocklist.ts";
import * as ClankwallLive from "./live/clankwall.ts";
import type { BrowserContext } from "./live/clankwall.ts";
import * as XSessionLive from "./live/x-session.ts";
import type { BrowserPage } from "./live/x-session.ts";
import { Settings } from "./settings.ts";

const settings = Layer.succeed(
  Settings,
  Settings.of({ dryRun: false, pause: { min: 4000, max: 7000 } })
);

/**
 * Entry point of the bundle `browse execute` runs: it passes in its `page`
 * and `context` and prints the returned report as JSON.
 */
export const main = (page: BrowserPage, context: BrowserContext) =>
  run().pipe(
    Effect.map((report) => ({
      ...report,
      stoppedAt: Option.getOrNull(report.stoppedAt),
    })),
    Effect.provide([
      XSessionLive.layer(page),
      ClankwallLive.layer(context),
      settings,
    ]),
    Effect.scoped,
    Effect.runPromise
  );
