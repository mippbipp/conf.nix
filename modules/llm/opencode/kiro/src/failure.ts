// What OpenCode is told when Kiro or the network says no: the status and
// message OpenCode acts on, and the Anthropic-style error response that
// carries them.

import { Array as Arr, Cause, Option, Predicate, Schema, String as Str } from "effect";
import { HttpClientError } from "effect/http";

// SignInError is a sign-in that is missing or that Kiro refused; OpenCode
// is told 401.
export class SignInError extends Schema.TaggedError<SignInError>()("SignInError", {
  message: Schema.String,
}) {}

// RefreshError is a refresh that got no usable answer; OpenCode is told 502
// and retries.
export class RefreshError extends Schema.TaggedError<RefreshError>()("RefreshError", {
  message: Schema.String,
}) {}

// KiroApiError is a call to Kiro's management API that failed: Kiro's
// status and body when it answered, 502 when it didn't.
export class KiroApiError extends Schema.TaggedError<KiroApiError>()("KiroApiError", {
  status: Schema.Finite,
  body: Schema.String,
  message: Schema.String,
}) {
  // fromReply is the error for an answer that wasn't OK, in Kiro's words
  // when its body has a message
  static fromReply(status: number, body: string) {
    const said = readErrorBody(body)?.message;
    return KiroApiError.make({
      status,
      body,
      message: said ? `Kiro: ${said} (HTTP ${status})` : `Kiro answered HTTP ${status}`,
    });
  }
}

// Failure is what OpenCode is told when a request fails. OpenCode reads the
// status and message to decide what to do, and shows the message, while it
// waits to retry too. retryAfter is Kiro's Retry-After, passed on for
// OpenCode's backoff. retry is false for a failure that would only repeat,
// which OpenCode would otherwise retry by its status.
export interface Failure {
  status: number;
  message: string;
  retryAfter?: string;
  retry?: false;
}

// Kiro's error bodies, and its event stream's exceptions
const ErrorBody = Schema.Struct({
  message: Schema.optional(Schema.NullOr(Schema.String)),
  Message: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));
const readErrorBody = (body: string) => Option.getOrUndefined(decodeErrorBody(body));

// kiroSaid is what Kiro's error says: its message and reason, or the body as it is
function kiroSaid(body: string) {
  const error = readErrorBody(body);
  const said = error?.message || error?.Message;
  if (said) return said + (error?.reason ? ` (${error.reason})` : "");
  return Str.trim(body);
}

// a squashed Cause: an Error's message, or what else failed as text
const messageOf = (cause: unknown) => (Predicate.isError(cause) && cause.message) || String(cause);

// what Kiro's reasons mean, whatever its status. OpenCode compacts the
// session on "prompt is too long" and stops on a 402.
const REASONS = [
  {
    pattern: /CONTENT_LENGTH_EXCEEDS_THRESHOLD|ContentLengthExceeds|input is too long/i,
    status: 400,
    words: "prompt is too long for this model's context window",
  },
  {
    pattern: /MONTHLY_REQUEST_COUNT|MonthlyLimitReached|USAGE_LIMIT/i,
    status: 402,
    words: "Kiro's monthly usage limit has been reached",
  },
  {
    pattern: /DAILY_REQUEST_COUNT/i,
    status: 402,
    words: "Kiro's daily request limit has been reached",
  },
  {
    pattern: /INSUFFICIENT_MODEL_CAPACITY/i,
    status: 503,
    words: "Kiro has no capacity for this model right now. If it keeps happening, switch models",
  },
];

// Kiro's kinds of error, known by the AWS error type (the x-amzn-errortype
// header, or the event stream's exception) or by the HTTP status, checked
// in this order. A status the kind has stays; any other becomes its first.
// OpenCode retries a 429 or a 5xx with backoff, and stops on a 4xx.
const KINDS = [
  { type: /throttl/i, statuses: [429], words: "Kiro is rate limiting requests" },
  { type: /validation/i, statuses: [400], words: "Kiro rejected the request" },
  {
    type: /accessdenied/i,
    statuses: [403, 401],
    words:
      "Kiro refused the request. If you signed out of kiro-cli or switched accounts, run `kiro-cli login`",
  },
  { type: /unavailable/i, statuses: [503], words: "Kiro is unavailable right now" },
] as const;

// classify gives a Kiro failure the status and words OpenCode acts on, with
// what Kiro said kept at the end.
function classify(status: number, said: string, type: string): Failure {
  const tail = said ? `. Kiro said: ${said}` : "";
  const all = `${type} ${said}`;
  const reason = Option.getOrUndefined(Arr.findFirst(REASONS, (known) => known.pattern.test(all)));
  if (reason) return { status: reason.status, message: reason.words + tail };
  const has = (known: (typeof KINDS)[number]) =>
    Arr.some(known.statuses, (kindStatus) => kindStatus === status);
  const kind = Option.getOrUndefined(
    Arr.findFirst(KINDS, (known) => known.type.test(type) || has(known))
  );
  if (kind) return { status: has(kind) ? status : kind.statuses[0], message: kind.words + tail };
  if (status >= 500) return { status, message: `Kiro had a server error${tail}` };
  return { status, message: `Kiro answered HTTP ${status}${tail}` };
}

// fromReply is the failure for an HTTP error Kiro answered with. A
// Retry-After Kiro sent goes on to OpenCode.
export function fromReply(
  status: number,
  body: string,
  headers: Readonly<Record<string, string | undefined>> = {}
): Failure {
  const type = Str.split(headers["x-amzn-errortype"] ?? "", ":")[0];
  const failure = classify(status, kiroSaid(body), type);
  const retryAfter = headers["retry-after"];
  return retryAfter ? { ...failure, retryAfter } : failure;
}

// fromException is the failure for an exception in Kiro's event stream:
// its kind's status, or a server error that names a kind not known.
export function fromException(type: string | undefined, payload: string): Failure {
  const known = type ?? "";
  const said = kiroSaid(payload);
  const kind = Option.getOrUndefined(
    Arr.findFirst(KINDS, (candidate) => candidate.type.test(known))
  );
  if (kind) return classify(kind.statuses[0], said, known);
  return classify(500, known && known !== "error" ? `${known}: ${said}` : said, known);
}

// fromCause is the failure for an Effect that failed on a request.
export function fromCause(cause: Cause.Cause<unknown>): Failure {
  const error = Cause.squash(cause);
  if (Schema.is(SignInError)(error)) return { status: 401, message: error.message };
  if (Schema.is(KiroApiError)(error)) return { status: error.status, message: error.message };
  if (Schema.is(RefreshError)(error)) return { status: 502, message: error.message };
  if (Cause.isTimeoutError(error)) return { status: 504, message: messageOf(error) };
  if (HttpClientError.isHttpClientError(error))
    return { status: 502, message: `Couldn't reach Kiro: ${error.message}` };
  // anything else is this plugin failing on the request, and a retry would
  // fail the same way
  return {
    status: 500,
    message: `The Kiro plugin failed on this request: ${messageOf(error)}`,
    retry: false,
  };
}

// brokeOff is a reply body that failed before its end
export const brokeOff = (why: string): Failure => ({
  status: 502,
  message: `Kiro's reply broke off before it finished: ${why}`,
});

// fromBody is the failure for a reply body that failed partway: a stall,
// a 504 OpenCode retries, when nothing arrived for idleSeconds
export function fromBody(cause: Cause.Cause<unknown>, idleSeconds: number): Failure {
  const error = Cause.squash(cause);
  if (Cause.isTimeoutError(error))
    return {
      status: 504,
      message: `Kiro stopped responding: nothing arrived for ${idleSeconds} seconds, so the reply was dropped`,
    };
  return brokeOff(messageOf(error));
}

// emptyReply is a reply that ended before its first event
export const emptyReply: Failure = {
  status: 502,
  message: "Kiro ended its reply without sending anything",
};

// Anthropic's error type for each status
const ERROR_TYPES = new Map([
  [400, "invalid_request_error"],
  [401, "authentication_error"],
  [402, "billing_error"],
  [403, "permission_error"],
  [404, "not_found_error"],
  [413, "request_too_large"],
  [429, "rate_limit_error"],
  [503, "overloaded_error"],
  [529, "overloaded_error"],
]);

// toError is the failure as the error object of an Anthropic Messages
// response or SSE error event
export const toError = (failure: Failure) => ({
  type: ERROR_TYPES.get(failure.status) ?? "api_error",
  message: failure.message,
});

// toResponse is the failure as an Anthropic Messages error response
export function toResponse(failure: Failure) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (failure.retryAfter) headers.set("retry-after", failure.retryAfter);
  if (failure.retry === false) headers.set("x-should-retry", "false");
  return Response.json(
    { type: "error", error: toError(failure) },
    { status: failure.status, headers }
  );
}
