// Messages requests for a test: Codex's view_image turn (yetone/magpie#1861),
// and PNGs built at the sizes a report gave (magpie-community/plugins#428).

import { crc32, deflateSync } from "node:zlib";

import { Array as Arr } from "effect";

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
  source: { data, media_type, type: "base64" },
  type: "image",
});

// Codex's turn: view_image called, and answered with content
export const viewImage = (
  content: Blocks
): MessagesRequest & {
  messages: NonNullable<MessagesRequest["messages"]>;
} => ({
  messages: [
    {
      content: [{ text: "take a screenshot and look at it", type: "text" }],
      role: "user",
    },
    {
      content: [
        {
          id: "call_view1",
          input: { path: "/tmp/a.png" },
          name: "view_image",
          type: "tool_use",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          cache_control: { type: "ephemeral" },
          content,
          tool_use_id: "call_view1",
          type: "tool_result",
        },
      ],
      role: "user",
    },
  ],
  model: "claude-sonnet-4.5",
  system: [{ text: "You are Codex.", type: "text" }],
  tools: [
    {
      description: "View a local image",
      input_schema: {
        properties: { path: { type: "string" } },
        type: "object",
      },
      name: "view_image",
    },
  ],
});

// codex is view_image answered with the image, then (when follow) a reply
// and a text-only question, the image still in history
export function codex(data: string, follow = false) {
  const req = viewImage([image(data)]);
  if (follow) {
    req.messages.push(
      {
        content: [{ text: "It is a contact sheet.", type: "text" }],
        role: "assistant",
      },
      { content: [{ text: "now make it smaller", type: "text" }], role: "user" }
    );
  }
  return req;
}

export const usersOf = (conversation: Conversation) =>
  Arr.append(
    Arr.flatMap(conversation.history ?? [], (entry) =>
      entry.userInputMessage === undefined ? [] : [entry.userInputMessage]
    ),
    conversation.currentMessage.userInputMessage
  );
export const imagesOf = (conversation: Conversation) =>
  Arr.flatMap(usersOf(conversation), (input) => input.images ?? []);

// ---- PNGs --------------------------------------------------------------------------

// Kiro turns away an image whose Base64 is over 5 MiB: Codex's view_image
// gave a PNG of 4,171,428 bytes, 5,561,904 as Base64, and Kiro refused that
// turn and every later one, as the image stays in history.
export const LIMIT = 5 * 1024 * 1024;
export const REPORTED_RAW = 4_171_428;
export const REPORTED_B64 = 5_561_904;

function pngChunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = (width: number, height: number) => {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 2; // RGB
  return pngChunk("IHDR", data);
};

// png is a width×height RGB PNG of noise (seeded, so the same each run: the
// worst case for a codec) or of flat grey, made exactly size bytes long with a
// private ancillary chunk, which no decoder looks at.
export function png(
  width: number,
  height: number,
  { noise = true, size }: { noise?: boolean; size?: number } = {}
) {
  const row = 1 + width * 3;
  const rows = Buffer.alloc(height * row, 128);
  if (noise) {
    let seed = 2_654_435_769 % 2_147_483_647;
    for (let i = 0; i < rows.length; i += 1) {
      if (i % row === 0) {
        rows[i] = 0;
      } else {
        seed = (seed * 48_271) % 2_147_483_647;
        rows[i] = seed % 256;
      }
    }
  } else {
    for (let line = 0; line < height; line += 1) {
      rows[line * row] = 0;
    }
  }
  // oxlint-disable-next-line node/no-sync -- the PNGs are fixtures built once, as the module loads
  const idat = pngChunk("IDAT", deflateSync(rows, { level: noise ? 0 : 9 }));
  const end = pngChunk("IEND", Buffer.alloc(0));
  const file = Buffer.concat([PNG_SIG, ihdr(width, height), idat, end]);
  if (size === undefined) {
    return file;
  }
  const pad = size - file.length - 12;
  if (pad < 0) {
    throw new Error(
      `a ${width}x${height} PNG is ${file.length} bytes, over ${size}`
    );
  }
  return Buffer.concat([
    PNG_SIG,
    ihdr(width, height),
    pngChunk("pdNg", Buffer.alloc(pad, 42)),
    idat,
    end,
  ]);
}

// bomb is a header saying 20000×20000 (400M pixels) with almost nothing behind it
export function bomb(size: number) {
  // oxlint-disable-next-line node/no-sync -- see png
  const idat = pngChunk("IDAT", deflateSync(Buffer.alloc(1000)));
  const end = pngChunk("IEND", Buffer.alloc(0));
  const head = Buffer.concat([PNG_SIG, ihdr(20_000, 20_000)]);
  const pad = size - head.length - idat.length - end.length - 12;
  return Buffer.concat([
    head,
    pngChunk("pdNg", Buffer.alloc(pad, 42)),
    idat,
    end,
  ]);
}

// the reporter's image: a 1389×1000 noise PNG, 4,171,428 bytes
export const reported = png(1389, 1000, { size: REPORTED_RAW });
export const REPORTED = reported.toString("base64");
