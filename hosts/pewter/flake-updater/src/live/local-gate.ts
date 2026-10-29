import {
  Array as Arr,
  Effect,
  Layer,
  Record as Rec,
  Schema,
  String as Str,
} from "effect";

import { Shell } from "../command.ts";
import { Gate, GateError } from "../gate.ts";
import { Host } from "../settings.ts";

const HostSystems = Schema.Record(Schema.String, Schema.String);

const decodeSystems = Schema.decodeEffect(Schema.fromJsonString(HostSystems));

const fail = (message: string) => (cause: unknown) =>
  GateError.make({ message, cause });

// Same shape as `gh run view --log-failed`, so the trimmer attributes errors
// to hosts the way it does for the real gate.
const asJobLog = (job: string, text: string) =>
  Arr.join(
    Arr.map(Str.split(text, "\n"), (line) => `${job}\tlocal\t- ${line}`),
    "\n"
  );

/**
 * Dry runs cannot push, so they stand the Build gate in with local
 * evaluation: every host's toplevel drvPath plus `nix flake check
 * --no-build`. This catches eval breakage, not build failures.
 */
export const layer = Layer.effect(
  Gate,
  Effect.gen(function* () {
    const host = yield* Host;
    const { exec, run } = yield* Shell;

    const verdict = Effect.fn("LocalGate.verdict")(function* () {
      const systems = yield* run(
        "nix",
        [
          "eval",
          "--json",
          ".#nixosConfigurations",
          "--apply",
          "builtins.mapAttrs (_: c: c.config.nixpkgs.hostPlatform.system)",
        ],
        { cwd: host.repoDir }
      ).pipe(
        Effect.flatMap(decodeSystems),
        Effect.mapError(fail("listing hosts"))
      );

      const sections: string[] = [];

      for (const name of Arr.sort(Rec.keys(systems), Str.Order)) {
        yield* Effect.log(`evaluating ${name}`);

        const output = yield* exec(
          "nix",
          [
            "eval",
            "--raw",
            `.#nixosConfigurations.${name}.config.system.build.toplevel.drvPath`,
          ],
          { cwd: host.repoDir }
        ).pipe(Effect.mapError(fail(`evaluating ${name}`)));

        if (output.exitCode !== 0) {
          sections.push(
            `##[group]build ${name}\n${output.stderr}\n##[endgroup]`
          );
        }
      }

      const checks = yield* exec("nix", ["flake", "check", "--no-build"], {
        cwd: host.repoDir,
      }).pipe(Effect.mapError(fail("running nix flake check")));

      const failed = [];

      if (Arr.isReadonlyArrayNonEmpty(sections)) {
        failed.push({
          name: "build local",
          url: "(local evaluation)",
          log: asJobLog("build local", Arr.join(sections, "\n")),
        });
      }

      if (checks.exitCode !== 0) {
        failed.push({
          name: "checks local",
          url: "(local evaluation)",
          log: asJobLog("checks local", checks.stderr),
        });
      }

      return { failed };
    });

    return Gate.of({ verdict: () => verdict() });
  })
);
