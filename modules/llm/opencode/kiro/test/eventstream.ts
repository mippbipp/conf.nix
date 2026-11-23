// Kiro's reply and OpenCode's view of it for a test: AWS event stream
// messages as Kiro sends them, and the Anthropic SSE events read back out
// of a Messages response.

import { Array as Arr, Effect, Option, Schema, String as Str } from "effect";

import { toJson } from "./json.ts";

// frame is an AWS event stream message; the reader doesn't check the checksums
export function frame(
  eventType: string,
  payload: Schema.JsonObject,
  messageType = "event"
) {
  const enc = new TextEncoder();
  const header = (name: string, value: string) => {
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    return [
      nameBytes.length,
      ...nameBytes,
      7,
      Math.floor(valueBytes.length / 256),
      valueBytes.length % 256,
      ...valueBytes,
    ];
  };
  const headers = new Uint8Array([
    ...header(":message-type", messageType),
    ...header(
      messageType === "exception" ? ":exception-type" : ":event-type",
      eventType
    ),
  ]);
  const body = enc.encode(toJson(payload));
  const total = 12 + headers.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  out.set(headers, 12);
  out.set(body, 12 + headers.length);
  return out;
}

// a JSON object with these fields, and any others as they are
const loose = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Json),
  ]);
const text = Schema.optionalKey(Schema.String);
const ErrorBlock = loose({ message: Schema.String, type: Schema.String });
const Delta = loose({
  stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  text,
  thinking: text,
  type: text,
});

// an Anthropic SSE event, with the fields tests read typed
const SseEvent = loose({
  content_block: Schema.optionalKey(loose({ name: text, type: Schema.String })),
  delta: Schema.optionalKey(Delta),
  error: Schema.optionalKey(ErrorBlock),
  type: Schema.String,
  usage: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(SseEvent));
const decodeError = Schema.decodeUnknownEffect(
  Schema.fromJsonString(loose({ error: ErrorBlock }))
);

const textOf = (res: Response) => Effect.promise(() => res.text());

// sse reads an Anthropic SSE body into its events
export const sse = Effect.fnUntraced(function* (res: Response) {
  const body = yield* textOf(res);
  const blocks = Arr.filter(Str.split(body, "\n\n"), (block) => block !== "");
  return yield* Effect.forEach(
    blocks,
    (block) => {
      const data = Arr.findFirst(
        Str.split(block, "\n"),
        Str.startsWith("data: ")
      );
      return decodeEvent(Str.slice(6)(Option.getOrThrow(data)));
    },
    { concurrency: 1 }
  );
});

// errorOf reads an Anthropic error body
export const errorOf = (res: Response) =>
  textOf(res).pipe(
    Effect.flatMap(decodeError),
    Effect.map((body) => body.error)
  );
