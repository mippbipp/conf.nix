// Images over Kiro's size limit, through src/images.ts's Images.fit on
// requests src/conversation.ts's open builds. Run with BUN_BE_BUN=1
// opencode test.

import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { Array as Arr, Effect, Option, String as Str } from "effect";

import { type MessagesRequest, open } from "../src/conversation.ts";
import { Images } from "../src/images.ts";
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

const run = <A>(effect: Effect.Effect<A, never, Images>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Images.layer)));
const built = (req: MessagesRequest) => open(req, []).request("");

// fitted is each request as Kiro would be sent it, fitted by one Images
const fitted = (...reqs: MessagesRequest[]) =>
  run(
    Effect.gen(function* () {
      const images = yield* Images;
      const out: Conversation[] = [];
      for (const req of reqs) out.push((yield* images.fit(built(req))).conversationState);
      return out;
    })
  );
const fit = async (req: MessagesRequest) => (await fitted(req))[0]!;
// the conversation with its images' bytes and format left out, which
// fitting may change
const withoutImageBytes = (conversation: Conversation) => {
  // SAFETY: a clone of conversation, made Partial so its id can be dropped
  const copy = structuredClone(conversation) as Partial<Conversation>;
  delete copy.conversationId;
  // SAFETY: only the id is gone, which usersOf doesn't read
  for (const input of usersOf(copy as Conversation))
    if (input.images)
      input.images = Arr.map(input.images, () => ({ format: "", source: { bytes: "…" } }));
  return copy;
};
const meta = (b64: string) => new Bun.Image(Buffer.from(b64, "base64")).metadata();

test("an image over Kiro's limit is made small enough to send", async () => {
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
  randomBytes(pixels).copy(bmp, 54);
  const b64 = bmp.toString("base64");
  const state = await fit({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "what is this?" }, image(b64, "image/bmp")],
      },
    ],
  });
  const [sent] = state.currentMessage.userInputMessage.images ?? [];
  expect(b64.length).toBeGreaterThan(LIMIT);
  expect(sent?.format).toBe("webp");
  expect(sent?.source.bytes.length).toBeLessThanOrEqual(LIMIT);
});

test("the fixture is the reported image's size: under 5 MiB as a file, over it as Base64", () => {
  expect(reported.length).toBe(REPORTED_RAW);
  expect(REPORTED.length).toBe(REPORTED_B64);
  // and the request alone leaves it as it is, which is what Kiro refused
  const state = built(codex(REPORTED)).conversationState;
  expect(state.currentMessage.userInputMessage.images?.[0]?.source.bytes.length).toBe(REPORTED_B64);
});

test("the reported tool image goes under the limit as an image Kiro can read, the conversation otherwise the same", async () => {
  const req = codex(REPORTED);
  const before = structuredClone(req);
  const state = await fit(req);
  const [sent] = imagesOf(state);
  expect(imagesOf(state)).toHaveLength(1);
  expect(sent!.source.bytes.length).toBeLessThanOrEqual(LIMIT);
  // it decodes as the kind it is declared as, the same shape
  const decoded = await meta(sent!.source.bytes);
  expect<string>(decoded.format).toBe(sent!.format);
  expect(decoded.width / decoded.height).toBeCloseTo(1389 / 1000, 2);
  expect(withoutImageBytes(state)).toEqual(withoutImageBytes(built(req).conversationState));
  // the caller's request is untouched
  expect(req).toEqual(before);
}, 60_000);

test("a text-only turn after the image goes too: the image in history is fitted, nothing else moves", async () => {
  const req = codex(REPORTED, true);
  const state = await fit(req);
  const plain = built(req).conversationState;
  // the image stays where the latest-image rule left it, in history
  expect(state.currentMessage.userInputMessage.images).toBeUndefined();
  expect(state.currentMessage.userInputMessage.content).toBe("now make it smaller");
  const where = (conversation: Conversation) =>
    Arr.map(usersOf(conversation), (input) => input.images?.length ?? 0);
  expect(where(state)).toEqual(where(plain));
  expect(imagesOf(state)).toHaveLength(1);
  expect(imagesOf(state)[0]!.source.bytes.length).toBeLessThanOrEqual(LIMIT);
  expect(withoutImageBytes(state)).toEqual(withoutImageBytes(plain));
}, 60_000);

test("at the limit an image is sent byte for byte; one Base64 quad over, it is fitted", async () => {
  // 3,932,160 bytes is 5,242,880 Base64 characters, no padding;
  // 3,932,159 is the same length ending in "="; 3,932,161 is 5,242,884
  const b64 = (size: number) => png(64, 48, { noise: false, size }).toString("base64");
  const [at, padded, over] = [b64(3_932_160), b64(3_932_159), b64(3_932_161)];
  expect([at.length, padded.length, over.length]).toEqual([LIMIT, LIMIT, LIMIT + 4]);
  expect(padded).toEndWith("=");
  for (const data of [at, padded]) {
    const [sent] = imagesOf(await fit(codex(data)));
    expect(sent).toEqual({ format: "png", source: { bytes: data } });
  }
  const [sent] = imagesOf(await fit(codex(over)));
  expect(sent!.source.bytes.length).toBeLessThan(LIMIT);
  const decoded = await meta(sent!.source.bytes);
  expect([decoded.format, decoded.width, decoded.height]).toEqual(["png", 64, 48]);
});

test("small images beside a large one are left as they are, in their order", async () => {
  const small = png(8, 8, { noise: false }).toString("base64");
  const state = await fit(
    viewImage([image(small), image(REPORTED), { type: "text", text: "two images" }, image(small)])
  );
  const got = state.currentMessage.userInputMessage.images ?? [];
  expect(got).toHaveLength(3);
  expect(got[0]).toEqual({ format: "png", source: { bytes: small } });
  expect(got[2]).toEqual({ format: "png", source: { bytes: small } });
  expect(got[1]!.source.bytes.length).toBeLessThanOrEqual(LIMIT);
  expect(
    state.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.[0]?.content
  ).toEqual([{ text: "two images" }]);
}, 60_000);

test("an image that can't be read, or claims too many pixels, becomes a note and the turn still goes", async () => {
  const junk = Buffer.alloc(4_000_000, 0x5a).toString("base64");
  const huge = bomb(4_000_000).toString("base64");
  expect(junk.length).toBeGreaterThan(LIMIT);
  expect(huge.length).toBeGreaterThan(LIMIT);
  for (const [data, why] of [
    [junk, "it couldn't be read as an image"],
    [huge, "it has too many pixels to resize"],
  ] as const) {
    const state = await fit(codex(data, true));
    expect(imagesOf(state)).toEqual([]);
    const noted = Option.getOrUndefined(
      Arr.findFirst(usersOf(state), (input) => Str.includes("was left out")(input.content))
    );
    expect(noted?.content).toContain(why);
    expect(noted?.content).toContain("5.0 MB");
    // the note names no bytes and no path
    expect(noted!.content.length).toBeLessThan(300);
    expect(noted?.content).not.toContain("/tmp");
    // the tool's answer is still paired with its call
    expect(noted?.userInputMessageContext?.toolResults?.[0]?.toolUseId).toBe("call_view1");
    expect(state.currentMessage.userInputMessage.content).toBe("now make it smaller");
  }
});

test("an image is fitted once, and the next turn sends the same fitted bytes", async () => {
  const real = Bun.Image;
  let made = 0;
  Bun.Image = class extends real {
    constructor(...args: ConstructorParameters<typeof real>) {
      super(...args);
      made++;
    }
  };
  try {
    const flat = png(64, 48, { noise: false, size: 3_932_161 + 3 * 7 }).toString("base64");
    let once = 0;
    const [first, second] = await run(
      Effect.gen(function* () {
        const images = yield* Images;
        const before = yield* images.fit(built(codex(flat)));
        once = made;
        const after = yield* images.fit(built(codex(flat, true)));
        return Arr.map([before, after], (result) => result.conversationState);
      })
    );
    expect(once).toBeGreaterThan(0);
    expect(made).toBe(once);
    expect(imagesOf(second!)[0]!.source.bytes).toBe(imagesOf(first!)[0]!.source.bytes);
  } finally {
    Bun.Image = real;
  }
});

test("a host without Bun.Image sends a note in the image's place", async () => {
  const real = Bun.Image;
  // SAFETY: Bun's Image is writable; the test puts it back afterwards
  (Bun as { Image?: unknown }).Image = undefined;
  try {
    const flat = png(64, 48, { noise: false, size: 3_932_161 + 3 * 11 }).toString("base64");
    const state = await fit(codex(flat));
    expect(imagesOf(state)).toEqual([]);
    expect(state.currentMessage.userInputMessage.content).toContain(
      "this plugin host can't resize images"
    );
  } finally {
    Bun.Image = real;
  }
});
