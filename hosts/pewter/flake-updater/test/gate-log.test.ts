import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, String as Str } from "effect";

import { trimGateLog } from "../src/gate-log.ts";
import { gate232 } from "./fixtures/gate-232.ts";

const line = (job: string, text: string) =>
  `${job}\tbuild\t2026-10-26T09:28:34.0000000Z ${text}`;

const hostSection = (host: string, error: readonly string[]) => [
  line("build x86_64-linux", `##[group]build ${host}`),
  ...Arr.map(error, (text) => line("build x86_64-linux", text)),
  line("build x86_64-linux", "##[endgroup]"),
];

describe("gate log trimmer", () => {
  it.effect("attributes the error blocks to the hosts that failed", () =>
    Effect.sync(() => {
      const excerpt = trimGateLog(gate232);

      assert.deepStrictEqual(excerpt.hosts, [
        "gram",
        "harpe",
        "pewter",
        "warpe",
      ]);
      assert.include(excerpt.text, "### build aarch64-linux (pewter)");
      assert.include(
        excerpt.text,
        "### build x86_64-linux (gram, harpe, warpe)"
      );
    })
  );

  it.effect(
    "keeps one copy of an error that differs only in store hashes",
    () =>
      Effect.sync(() => {
        const excerpt = trimGateLog(gate232);

        const sections = Arr.filter(Str.split(excerpt.text, "\n"), (text) =>
          Str.startsWith("### ")(text)
        );

        assert.lengthOf(sections, 2);
        assert.notMatch(excerpt.text, /\/nix\/store\/[0-9a-z]{32}-/u);
        assert.include(
          excerpt.text,
          "/nix/store/…-source/modules/system/config"
        );
      })
  );

  it.effect("caps a block at 120 lines", () =>
    Effect.sync(() => {
      const frames = Arr.makeBy(300, (index) => `       frame ${index}`);
      const log = Arr.join(hostSection("gram", ["error:", ...frames]), "\n");

      const excerpt = trimGateLog(log);

      assert.include(excerpt.text, "frame 118");
      assert.notInclude(excerpt.text, "frame 119");
    })
  );

  it.effect("truncates once the excerpt passes 16,000 characters", () =>
    Effect.sync(() => {
      const filler = Str.repeat(1000)("x");

      const sections = Arr.makeBy(40, (index) =>
        hostSection(`host${index}`, [
          `error: failure ${index}`,
          `       ${filler}`,
        ])
      );

      const excerpt = trimGateLog(Arr.join(Arr.flatten(sections), "\n"));

      assert.isAtMost(excerpt.text.length, 16_100);
      assert.include(excerpt.text, "[further errors truncated]");
      assert.include(excerpt.text, "failure 0\n");
      assert.notInclude(excerpt.text, "failure 39\n");
      assert.lengthOf(excerpt.hosts, 40);
    })
  );
});
