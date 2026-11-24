// Images over Kiro's size limit, through src/images.ts's Images.fit on
// requests src/conversation.ts's open builds.

import { assert, it } from "@effect/vitest";
import { Array as Arr, Effect, Option, String as Str } from "effect";

import { type MessagesRequest, open } from "../src/conversation.ts";
import { Images } from "../src/images.ts";
import { assertCloseTo, assertEndsWith } from "./assert.ts";
import {
  bomb,
  codex,
  type Conversation,
  image,
  imagesOf,
  LIMIT,
  png,
  REPORTED,
  REPORTED_B64,
  REPORTED_RAW,
  reported,
  usersOf,
  viewImage,
} from "./messages.ts";

// run runs effect with an Images of its own
const run = <A, E>(effect: Effect.Effect<A, E, Images>) =>
  Effect.provide(effect, Images.layer);
const built = (req: MessagesRequest) => open(req, []).request("");

// fitted is each request as Kiro would be sent it, fitted by one Images
const fitted = (...reqs: Array<MessagesRequest>) =>
  run(
    Effect.gen(function* () {
      const images = yield* Images;
      const out: Array<Conversation> = [];
      for (const req of reqs) {
        out.push((yield* images.fit(built(req))).conversationState);
      }
      return out;
    })
  );
const fit = (req: MessagesRequest) =>
  fitted(req).pipe(Effect.map((out) => Option.getOrThrow(Arr.head(out))));
// the conversation with its images' bytes and format left out, which
// fitting may change
const withoutImageBytes = (conversation: Conversation) => {
  // SAFETY: a clone of conversation, made Partial so its id can be dropped
  const copy = structuredClone(conversation) as Partial<Conversation>;
  delete copy.conversationId;
  // SAFETY: only the id is gone, which usersOf doesn't read
  for (const input of usersOf(copy as Conversation)) {
    if (input.images !== undefined) {
      input.images = Arr.map(input.images, () => ({
        format: "",
        source: { bytes: "…" },
      }));
    }
  }
  return copy;
};
const meta = (b64: string) =>
  Effect.promise(() => new Bun.Image(Buffer.from(b64, "base64")).metadata());
// noise is size random bytes
const noise = (size: number) => {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += 65_536) {
    crypto.getRandomValues(bytes.subarray(at, at + 65_536));
  }
  return bytes;
};
// where is how many images each user message holds
const where = (conversation: Conversation) =>
  Arr.map(usersOf(conversation), (input) => input.images?.length ?? 0);
// flatOf is a 64x48 grey PNG of size bytes, as Base64
const flatOf = (size: number) =>
  png(64, 48, { noise: false, size }).toString("base64");
// withBunImage runs effect with Bun.Image set to image, and puts it back
const withBunImage = <A, E, R>(
  replacement: typeof Bun.Image | undefined,
  effect: Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const real = Bun.Image;
      // SAFETY: Bun's Image is writable; the release puts it back
      (Bun as { Image?: typeof Bun.Image }).Image = replacement;
      return real;
    }),
    () => effect,
    (real) =>
      Effect.sync(() => {
        Bun.Image = real;
      })
  );

it.effect("an image over Kiro's limit is made small enough to send", () =>
  Effect.gen(function* () {
    // a BMP of noise, which no lossless format makes small: 1200² pixels is
    // 4.3 MB, 5.8 MB as Base64
    const side = 1200;
    const pixels = side * side * 3;
    const bmp = Buffer.alloc(54 + pixels);
    bmp.write("BM", 0);
    bmp.writeUInt32LE(54 + pixels, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(side, 18);
    bmp.writeInt32LE(side, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp.set(noise(pixels), 54);
    const b64 = bmp.toString("base64");
    const state = yield* fit({
      messages: [
        {
          content: [
            { text: "what is this?", type: "text" },
            image(b64, "image/bmp"),
          ],
          role: "user",
        },
      ],
    });
    const [sent] = state.currentMessage.userInputMessage.images ?? [];
    assert.isAbove(b64.length, LIMIT);
    assert.strictEqual(sent?.format, "webp");
    assert.isAtMost(sent?.source.bytes.length ?? Infinity, LIMIT);
  })
);

it.effect(
  "the fixture is the reported image's size: under 5 MiB as a file, over it as Base64",
  () =>
    Effect.sync(() => {
      assert.strictEqual(reported.length, REPORTED_RAW);
      assert.strictEqual(REPORTED.length, REPORTED_B64);
      // and the request alone leaves it as it is, which is what Kiro refused
      const state = built(codex(REPORTED)).conversationState;
      assert.strictEqual(
        state.currentMessage.userInputMessage.images?.[0]?.source.bytes.length,
        REPORTED_B64
      );
    })
);

it.effect(
  "the reported tool image goes under the limit as an image Kiro can read, the conversation otherwise the same",
  () =>
    Effect.gen(function* () {
      const req = codex(REPORTED);
      const before = structuredClone(req);
      const state = yield* fit(req);
      const [sent] = imagesOf(state);
      assert.lengthOf(imagesOf(state), 1);
      assert.isDefined(sent);
      assert.isAtMost(sent.source.bytes.length, LIMIT);
      // it decodes as the kind it is declared as, the same shape
      const decoded = yield* meta(sent.source.bytes);
      assert.strictEqual<string>(decoded.format, sent.format);
      assertCloseTo(decoded.width / decoded.height, 1389 / 1000);
      assert.deepStrictEqual(
        withoutImageBytes(state),
        withoutImageBytes(built(req).conversationState)
      );
      // the caller's request is untouched
      assert.deepStrictEqual(req, before);
    }),
  60_000
);

it.effect(
  "a text-only turn after the image goes too: the image in history is fitted, nothing else moves",
  () =>
    Effect.gen(function* () {
      const req = codex(REPORTED, true);
      const state = yield* fit(req);
      const plain = built(req).conversationState;
      // the image stays where the latest-image rule left it, in history
      assert.isUndefined(state.currentMessage.userInputMessage.images);
      assert.strictEqual(
        state.currentMessage.userInputMessage.content,
        "now make it smaller"
      );
      assert.deepStrictEqual(where(state), where(plain));
      assert.lengthOf(imagesOf(state), 1);
      const [fittedImage] = imagesOf(state);
      assert.isDefined(fittedImage);
      assert.isAtMost(fittedImage.source.bytes.length, LIMIT);
      assert.deepStrictEqual(
        withoutImageBytes(state),
        withoutImageBytes(plain)
      );
    }),
  60_000
);

it.effect(
  "at the limit an image is sent byte for byte; one Base64 quad over, it is fitted",
  () =>
    Effect.gen(function* () {
      // 3,932,160 bytes is 5,242,880 Base64 characters, no padding;
      // 3,932,159 is the same length ending in "="; 3,932,161 is 5,242,884
      const [at, padded, over] = [
        flatOf(3_932_160),
        flatOf(3_932_159),
        flatOf(3_932_161),
      ];
      assert.deepStrictEqual(
        [at.length, padded.length, over.length],
        [LIMIT, LIMIT, LIMIT + 4]
      );
      assertEndsWith(padded, "=");
      for (const data of [at, padded]) {
        const keptState = yield* fit(codex(data));
        const [kept] = imagesOf(keptState);
        assert.deepStrictEqual(kept, {
          format: "png",
          source: { bytes: data },
        });
      }
      const overState = yield* fit(codex(over));
      const [sent] = imagesOf(overState);
      assert.isDefined(sent);
      assert.isBelow(sent.source.bytes.length, LIMIT);
      const decoded = yield* meta(sent.source.bytes);
      assert.deepStrictEqual(
        [decoded.format, decoded.width, decoded.height],
        ["png", 64, 48]
      );
    })
);

it.effect(
  "small images beside a large one are left as they are, in their order",
  () =>
    Effect.gen(function* () {
      const small = png(8, 8, { noise: false }).toString("base64");
      const state = yield* fit(
        viewImage([
          image(small),
          image(REPORTED),
          { text: "two images", type: "text" },
          image(small),
        ])
      );
      const got = state.currentMessage.userInputMessage.images ?? [];
      assert.lengthOf(got, 3);
      assert.deepStrictEqual(got[0], {
        format: "png",
        source: { bytes: small },
      });
      assert.deepStrictEqual(got[2], {
        format: "png",
        source: { bytes: small },
      });
      assert.isAtMost(got[1]?.source.bytes.length ?? Infinity, LIMIT);
      assert.deepStrictEqual(
        state.currentMessage.userInputMessage.userInputMessageContext
          ?.toolResults?.[0]?.content,
        [{ text: "two images" }]
      );
    }),
  60_000
);

it.effect(
  "an image that can't be read, or claims too many pixels, becomes a note and the turn still goes",
  () =>
    Effect.gen(function* () {
      const junk = Buffer.alloc(4_000_000, 90).toString("base64");
      const huge = bomb(4_000_000).toString("base64");
      assert.isAbove(junk.length, LIMIT);
      assert.isAbove(huge.length, LIMIT);
      for (const [data, why] of [
        [junk, "it couldn't be read as an image"],
        [huge, "it has too many pixels to resize"],
      ] as const) {
        const state = yield* fit(codex(data, true));
        assert.deepStrictEqual(imagesOf(state), []);
        const noted = Option.getOrUndefined(
          Arr.findFirst(usersOf(state), (input) =>
            Str.includes("was left out")(input.content)
          )
        );
        assert.include(noted?.content, why);
        assert.include(noted?.content, "5.0 MB");
        // the note names no bytes and no path
        assert.isDefined(noted);
        assert.isBelow(noted.content.length, 300);
        assert.notInclude(noted?.content, "/tmp");
        // the tool's answer is still paired with its call
        assert.strictEqual(
          noted?.userInputMessageContext?.toolResults?.[0]?.toolUseId,
          "call_view1"
        );
        assert.strictEqual(
          state.currentMessage.userInputMessage.content,
          "now make it smaller"
        );
      }
    })
);

it.effect(
  "an image is fitted once, and the next turn sends the same fitted bytes",
  () =>
    Effect.gen(function* () {
      let made = 0;
      const counted = class extends Bun.Image {
        public constructor(...args: ConstructorParameters<typeof Bun.Image>) {
          super(...args);
          made += 1;
        }
      };
      const flat = flatOf(3_932_161 + 3 * 7);
      let once = 0;
      const [first, second] = yield* withBunImage(
        counted,
        run(
          Effect.gen(function* () {
            const images = yield* Images;
            const before = yield* images.fit(built(codex(flat)));
            once = made;
            const after = yield* images.fit(built(codex(flat, true)));
            return Arr.map(
              [before, after],
              (result) => result.conversationState
            );
          })
        )
      );
      assert.isAbove(once, 0);
      assert.strictEqual(made, once);
      assert.isDefined(first);
      assert.isDefined(second);
      assert.strictEqual(
        imagesOf(second)[0]?.source.bytes,
        imagesOf(first)[0]?.source.bytes
      );
    })
);

it.effect("a host without Bun.Image sends a note in the image's place", () =>
  Effect.gen(function* () {
    const flat = flatOf(3_932_161 + 3 * 11);
    const state = yield* withBunImage(undefined, fit(codex(flat)));
    assert.deepStrictEqual(imagesOf(state), []);
    assert.include(
      state.currentMessage.userInputMessage.content,
      "this plugin host can't resize images"
    );
  })
);
