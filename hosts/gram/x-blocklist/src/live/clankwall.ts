import { Effect, Layer, Option } from "effect";
import { HttpClient } from "effect/http";

import {
  Clankwall,
  ClankwallError,
  decodeFlaggedPage,
  firstPage,
} from "../clankwall.ts";

const origin = "https://clankwall.vogel.dev";

export const layer = Layer.effect(
  Clankwall,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    return Clankwall.of({
      flaggedPage: Effect.fn("ClankwallLive.flaggedPage")(function* (cursor) {
        const path = Option.getOrElse(cursor, () => firstPage);

        const response = yield* http
          .get(`${origin}${path}`)
          .pipe(
            Effect.mapError(() =>
              ClankwallError.make({ message: "could not read Clankwall" })
            )
          );

        if (response.status !== 200) {
          return yield* ClankwallError.make({
            message: `Clankwall answered ${response.status}`,
          });
        }

        const body = yield* response.text.pipe(
          Effect.mapError(() =>
            ClankwallError.make({ message: "could not read Clankwall" })
          )
        );

        return yield* decodeFlaggedPage(body);
      }),
    });
  })
);
