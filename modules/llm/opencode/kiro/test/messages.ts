// Messages requests for a test: Codex's view_image turn (yetone/magpie#1861),
// and PNGs built at the sizes a report gave (magpie-community/plugins#428).

import { deflateSync } from "node:zlib";

import type { KiroRequest, MessagesRequest } from "../src/conversation.ts";

export type Conversation = KiroRequest["conversationState"];
export type Blocks = Exclude<
  NonNullable<MessagesRequest["messages"]>[number]["content"],
  string | undefined
>;

export const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const JPG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=";

export const image = (data: string, media_type = "image/png") => ({
  type: "image",
  source: { type: "base64", media_type, data },
});

// Codex's turn: view_image called, and answered with content
export const viewImage = (
  content: Blocks
): MessagesRequest & { messages: NonNullable<MessagesRequest["messages"]> } => ({
  model: "claude-sonnet-4.5",
  system: [{ type: "text", text: "You are Codex." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "take a screenshot and look at it" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_view1", name: "view_image", input: { path: "/tmp/a.png" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_view1",
          content,
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ],
  tools: [
    {
      name: "view_image",
      description: "View a local image",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
});

// codex is view_image answered with the image, then (when follow) a reply
// and a text-only question, the image still in history
export function codex(data: string, follow = false) {
  const r = viewImage([image(data)]);
  if (follow)
    r.messages.push(
      { role: "assistant", content: [{ type: "text", text: "It is a contact sheet." }] },
      { role: "user", content: [{ type: "text", text: "now make it smaller" }] }
    );
  return r;
}

export const usersOf = (s: Conversation) =>
  [...(s.history ?? []).map((e) => e.userInputMessage), s.currentMessage.userInputMessage].filter(
    (u) => u !== undefined
  );
export const imagesOf = (s: Conversation) => usersOf(s).flatMap((u) => u.images ?? []);

// ---- PNGs --------------------------------------------------------------------------

// Kiro turns away an image whose Base64 is over 5 MiB: Codex's view_image
// gave a PNG of 4,171,428 bytes, 5,561,904 as Base64, and Kiro refused that
// turn and every later one, as the image stays in history.
export const LIMIT = 5 * 1024 * 1024;
export const REPORTED_RAW = 4171428;
export const REPORTED_B64 = 5561904;

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = 8; // bit depth
  d[9] = 2; // RGB
  return pngChunk("IHDR", d);
};

// png is a w×h RGB PNG of noise (seeded, so the same each run: the worst
// case for a codec) or of flat grey, made exactly size bytes long with a
// private ancillary chunk, which no decoder looks at.
export function png(
  w: number,
  h: number,
  { noise = true, size }: { noise?: boolean; size?: number } = {}
) {
  const row = 1 + w * 3;
  const rows = Buffer.alloc(h * row, 0x80);
  if (noise) {
    let x = 0x9e3779b9;
    for (let i = 0; i < rows.length; i++) {
      if (i % row === 0) {
        rows[i] = 0;
        continue;
      }
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      rows[i] = x & 0xff;
    }
  } else for (let y = 0; y < h; y++) rows[y * row] = 0;
  const idat = pngChunk("IDAT", deflateSync(rows, { level: noise ? 0 : 9 }));
  const end = pngChunk("IEND", Buffer.alloc(0));
  const file = Buffer.concat([PNG_SIG, ihdr(w, h), idat, end]);
  if (size === undefined) return file;
  const pad = size - file.length - 12;
  if (pad < 0) throw new Error(`a ${w}x${h} PNG is ${file.length} bytes, over ${size}`);
  return Buffer.concat([PNG_SIG, ihdr(w, h), pngChunk("pdNg", Buffer.alloc(pad, 0x2a)), idat, end]);
}

// bomb is a header saying 20000×20000 (400M pixels) with almost nothing behind it
export function bomb(size: number) {
  const idat = pngChunk("IDAT", deflateSync(Buffer.alloc(1000)));
  const end = pngChunk("IEND", Buffer.alloc(0));
  const head = Buffer.concat([PNG_SIG, ihdr(20000, 20000)]);
  const pad = size - head.length - idat.length - end.length - 12;
  return Buffer.concat([head, pngChunk("pdNg", Buffer.alloc(pad, 0x2a)), idat, end]);
}

// the reporter's image: a 1389×1000 noise PNG, 4,171,428 bytes
export const reported = png(1389, 1000, { size: REPORTED_RAW });
export const REPORTED = reported.toString("base64");
