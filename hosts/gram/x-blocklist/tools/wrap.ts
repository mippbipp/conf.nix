// Turns the esbuild bundle into a `browse execute` script. The script body
// runs as an async function, so the bundle's `export { main }` becomes a
// local binding and the script returns the report. The bundle runs in an
// inner function that receives browse's `page` and `context` as parameters,
// because its own top-level names (Effect declares a `context`) would
// otherwise shadow them.
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, String as Str } from "effect";

const exportLine = /^export \{\s*main\s*\};\s*$/mu;

const wrap = Effect.fn("wrap")(function* (input: string, output: string) {
  const fs = yield* FileSystem.FileSystem;
  const bundle = yield* fs.readFileString(input);

  if (!exportLine.test(bundle)) {
    return yield* Effect.die(`${input} does not end with \`export { main };\``);
  }

  const script = Str.replace(exportLine, "")(bundle);

  return yield* fs.writeFileString(
    output,
    `return await (async (browsePage, browseContext) => {\n${script}\nreturn await main(browsePage, browseContext);\n})(page, context);\n`
  );
});

BunRuntime.runMain(
  wrap("dist/bundle.js", "dist/block.js").pipe(
    Effect.provide(BunServices.layer)
  )
);
