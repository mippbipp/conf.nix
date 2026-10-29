// Kiro's reply and OpenCode's view of it for a test: AWS event stream
// messages as Kiro sends them, and the Anthropic SSE events read back out
// of a Messages response.

import { Array as Arr, Option, type Schema, String as Str } from "effect";

// frame is an AWS event stream message; the reader doesn't check the checksums
export function frame(eventType: string, payload: Schema.JsonObject, messageType = "event") {
  const enc = new TextEncoder();
  const header = (name: string, value: string) => {
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    return [
      nameBytes.length,
      ...nameBytes,
      7,
      valueBytes.length >> 8,
      valueBytes.length & 255,
      ...valueBytes,
    ];
  };
  const headers = new Uint8Array([
    ...header(":message-type", messageType),
    ...header(messageType === "exception" ? ":exception-type" : ":event-type", eventType),
  ]);
  const body = enc.encode(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  out.set(headers, 12);
  out.set(body, 12 + headers.length);
  return out;
}

// sse reads an Anthropic SSE body into its events
export async function sse(res: Response) {
  const blocks = Arr.filter(Str.split(await res.text(), "\n\n"), (block) => block !== "");
  return Arr.map(blocks, (block) => {
    const data = Arr.findFirst(Str.split(block, "\n"), Str.startsWith("data: "));
    return JSON.parse(Str.slice(6)(Option.getOrThrow(data)));
  });
}

// errorOf reads an Anthropic error body
// SAFETY: every error response the plugin writes has this shape (Failure.toResponse)
export const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { type: string; message: string } }).error;
