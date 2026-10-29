// Kiro's reply and OpenCode's view of it for a test: AWS event stream
// messages as Kiro sends them, and the Anthropic SSE events read back out
// of a Messages response.

// frame is an AWS event stream message; the reader doesn't check the checksums
export function frame(eventType: string, payload: object, messageType = "event") {
  const enc = new TextEncoder();
  const header = (name: string, value: string) => {
    const n = enc.encode(name);
    const v = enc.encode(value);
    return [n.length, ...n, 7, v.length >> 8, v.length & 255, ...v];
  };
  const headers = new Uint8Array([
    ...header(":message-type", messageType),
    ...header(messageType === "exception" ? ":exception-type" : ":event-type", eventType),
  ]);
  const body = enc.encode(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, total);
  v.setUint32(4, headers.length);
  out.set(headers, 12);
  out.set(body, 12 + headers.length);
  return out;
}

// sse reads an Anthropic SSE body into its events
export async function sse(res: Response) {
  return (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) =>
      JSON.parse(
        block
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6)
      )
    );
}

// errorOf reads an Anthropic error body
export const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { type: string; message: string } }).error;
