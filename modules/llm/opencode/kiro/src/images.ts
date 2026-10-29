// Images over Kiro's size limit, made small enough to send.
//
// Kiro turns away an image whose Base64 is over 5 MiB, counted on the encoded
// string, not the file (magpie-community/plugins#428), and the image stays in
// history, so every later turn would fail the same way. An image over the
// limit is made smaller on the request being sent, and one that can't be is
// replaced by a note.

import { createHash } from "node:crypto";

import { Array as Arr, Context, Effect, Layer, Predicate, Result } from "effect";

import type { KiroRequest } from "./conversation.ts";

type UserInput = KiroRequest["conversationState"]["currentMessage"]["userInputMessage"];
type KiroImage = NonNullable<UserInput["images"]>[number];

const IMAGE_LIMIT = 5 * 1024 * 1024; // Base64 characters
const IMAGE_EDGE = 2000; // a shrunk image's long edge (kirodotdev/Kiro#8884)
const IMAGE_MIN_EDGE = 256;
const IMAGE_MAX_PIXELS = 50_000_000; // a header claiming more is refused unread
const IMAGE_MAX_INPUT = 64 * 1024 * 1024; // Base64 characters looked at all
const IMAGE_DEADLINE = "30 seconds"; // how long one image may take
const FITTED_KEEP = 4;

// the code of an error Bun.Image fails with, as tryPromise's catch hands it on
const codeOf = (cause: unknown) => (Predicate.hasProperty(cause, "code") ? cause.code : undefined);

type Fitted = { format: string; bytes: string; note?: never } | { note: string; bytes?: never };

const mib = (length: number) => `${(length / (1024 * 1024)).toFixed(1)} MB`;

// an encoding to try: the format, and how to set it on an image
type Encoding = { format: string; encode: (img: Bun.Image) => Bun.Image };

// shrink tries the image's own format at Claude's size, then a lossy one
// (WebP keeps transparency, JPEG stays JPEG) smaller each time, until the
// Base64 fits.
const shrink = Effect.fnUntraced(
  function* (b64: string): Effect.fn.Return<Fitted> {
    if (!Predicate.isFunction(globalThis.Bun?.Image))
      return { note: "this plugin host can't resize images" };
    const raw = Buffer.from(b64, "base64");
    const meta = yield* Effect.tryPromise({
      try: () => new Bun.Image(raw, { maxPixels: IMAGE_MAX_PIXELS }).metadata(),
      catch: (error) => ({ code: codeOf(error) }),
    }).pipe(Effect.result);
    if (Result.isFailure(meta))
      return {
        note:
          meta.failure.code === "ERR_IMAGE_TOO_MANY_PIXELS"
            ? "it has too many pixels to resize"
            : "it couldn't be read as an image",
      };
    const { width, height, format } = meta.success;
    const long = Math.max(width, height);
    const jpeg = format === "jpeg";
    const own: Encoding = jpeg
      ? { format: "jpeg", encode: (img) => img.jpeg({ quality: 85 }) }
      : format === "webp"
        ? { format: "webp", encode: (img) => img.webp({ quality: 85 }) }
        : { format: "png", encode: (img) => img.png({ compressionLevel: 9 }) };
    const lossy = (quality: number): Encoding =>
      jpeg
        ? { format: "jpeg", encode: (img) => img.jpeg({ quality }) }
        : { format: "webp", encode: (img) => img.webp({ quality }) };
    const tries = [
      { edge: Math.min(long, IMAGE_EDGE), ...own },
      { edge: Math.min(long, IMAGE_EDGE), ...lossy(80) },
    ];
    for (let edge = Math.min(long, IMAGE_EDGE) * 0.7; edge >= IMAGE_MIN_EDGE; edge *= 0.7)
      tries.push({ edge: Math.round(edge), ...lossy(75) });
    for (const attempt of tries) {
      const out = yield* Effect.tryPromise({
        try: () => {
          let img = new Bun.Image(raw, { maxPixels: IMAGE_MAX_PIXELS });
          if (attempt.edge < long)
            img = img.resize(attempt.edge, attempt.edge, {
              fit: "inside",
              withoutEnlargement: true,
            });
          return attempt.encode(img).toBase64();
        },
        catch: (error) => ({ code: codeOf(error) }),
      }).pipe(Effect.result);
      if (Result.isFailure(out)) {
        if (out.failure.code === "ERR_IMAGE_FORMAT_UNSUPPORTED") continue;
        return { note: "it couldn't be resized" };
      }
      if (out.success.length <= IMAGE_LIMIT) return { format: attempt.format, bytes: out.success };
    }
    return { note: "it couldn't be made small enough" };
  },
  Effect.timeoutOrElse({
    duration: IMAGE_DEADLINE,
    orElse: () => Effect.succeed({ note: "resizing it took too long" }),
  }),
  Effect.catchDefect(() => Effect.succeed({ note: "it couldn't be resized" }))
);

// Images brings every image left in a built request under Kiro's limit.
// The last few results are kept, as an image stays in the conversation and
// is sent again with the turns after it.
export class Images extends Context.Service<
  Images,
  { readonly fit: (out: KiroRequest) => Effect.Effect<KiroRequest> }
>()("opencode-kiro/images") {
  static readonly layer = Layer.sync(Images, () => {
    const fitted = new Map<string, Fitted>(); // sha256 of the Base64 → the result, newest last

    const fitOne = Effect.fnUntraced(function* (b64: string) {
      const key = createHash("sha256").update(b64).digest("hex");
      let result = fitted.get(key);
      if (result) fitted.delete(key); // kept as the newest below
      else
        result =
          b64.length > IMAGE_MAX_INPUT ? { note: "it is too large to resize" } : yield* shrink(b64);
      fitted.set(key, result);
      for (const old of fitted.keys()) {
        if (fitted.size <= FITTED_KEEP) break;
        fitted.delete(old);
      }
      return result;
    });

    // fit changes the request in place; an image already under the limit is sent as it is
    const fit = Effect.fn("Images.fit")(function* (out: KiroRequest) {
      const state = out.conversationState;
      const users = Arr.append(
        Arr.flatMap(state.history ?? [], (entry) =>
          entry.userInputMessage ? [entry.userInputMessage] : []
        ),
        state.currentMessage.userInputMessage
      );
      for (const input of users) {
        if (!input.images?.length) continue;
        const kept: KiroImage[] = [];
        const notes: string[] = [];
        for (const img of input.images) {
          const b64 = img.source?.bytes;
          if (!Predicate.isString(b64) || b64.length <= IMAGE_LIMIT) {
            kept.push(img);
            continue;
          }
          const result = yield* fitOne(b64);
          if (result.bytes)
            kept.push({
              ...img,
              format: result.format,
              source: { ...img.source, bytes: result.bytes },
            });
          else
            notes.push(
              `[An image (${img.format}, ${mib(b64.length)} as Base64) was left out of this message: Kiro takes at most ${mib(IMAGE_LIMIT)} per image, and ${result.note}.]`
            );
        }
        if (kept.length) input.images = kept;
        else delete input.images;
        if (notes.length) {
          const note = Arr.join(notes, "\n");
          input.content = input.content ? `${input.content}\n\n${note}` : note;
        }
      }
      return out;
    });

    return Images.of({ fit });
  });
}
