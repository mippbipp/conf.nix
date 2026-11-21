import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { run } from "./blocklist.ts";
import type { Report } from "./blocklist.ts";
import { Browse } from "./browse.ts";
import { layer as clankwallLayer } from "./live/clankwall.ts";
import { layer as xSessionLayer } from "./live/x-session.ts";
import { Settings } from "./settings.ts";

const flags = {
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription(
      "Read both lists and report the pending changes without sending any"
    ),
    Flag.withDefault(false)
  ),
};

interface PrintedReport extends Omit<Report, "stoppedAt"> {
  readonly stoppedAt: number | null;
}

// The report holds only strings, numbers, booleans and null, so stringify
// cannot throw.
// oxlint-disable-next-line effecttsgo/global-json -- see above
const toJson = (report: PrintedReport): string => JSON.stringify(report);

const sync = Command.make(
  "x-blocklist",
  flags,
  Effect.fn("main")(function* (options) {
    const settings = Layer.succeed(
      Settings,
      Settings.of({
        dryRun: options.dryRun,
        pause: { max: 7000, min: 4000 },
      })
    );

    const live = Layer.mergeAll(
      xSessionLayer.pipe(Layer.provide(Browse.layer)),
      clankwallLayer.pipe(Layer.provide(FetchHttpClient.layer))
    );

    const report = yield* run().pipe(
      Effect.provide([live, settings]),
      Effect.scoped
    );

    // One JSON object on stdout, for the unit's journal and actions log.
    yield* Console.log(
      toJson({
        ...report,
        stoppedAt: Option.getOrNull(report.stoppedAt),
      })
    );
  })
).pipe(
  Command.withDescription(
    "Make the X account's blocked list match Clankwall's AI-flagged accounts"
  )
);

BunRuntime.runMain(
  sync.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(BunServices.layer)
  )
);
