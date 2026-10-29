import { Effect, Layer } from "effect";

import { Shell } from "../command.ts";
import { Nix, NixError } from "../nix.ts";
import { Host } from "../settings.ts";

export const layer = Layer.effect(
  Nix,
  Effect.gen(function* () {
    const host = yield* Host;
    const { run } = yield* Shell;

    return Nix.of({
      update: run("nix", ["flake", "update"], { cwd: host.repoDir }).pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          NixError.make({ message: "nix flake update failed", cause })
        )
      ),
    });
  })
);
