// What OpenCode is told when Kiro or the network says no, through
// src/failure.ts. Run with BUN_BE_BUN=1 opencode test.

import { expect, test } from "bun:test";

import { Cause, type Schema } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";

import * as Failure from "../src/failure.ts";

const body = (fields: Schema.JsonObject) => JSON.stringify(fields);
const errortype = (kind: string) => ({
  "x-amzn-errortype": `${kind}:http://internal.amazon.com/coral/com.amazon.aws.codewhisperer/`,
});

const REFUSED =
  "Kiro refused the request. If you signed out of kiro-cli or switched accounts, run `kiro-cli login`";

test("an HTTP answer and a stream exception of the same kind mean the same", () => {
  const kinds = [
    ["ThrottlingException", 429, "Kiro is rate limiting requests. Kiro said: no"],
    ["ValidationException", 400, "Kiro rejected the request. Kiro said: no"],
    ["AccessDeniedException", 403, `${REFUSED}. Kiro said: no`],
    ["ServiceUnavailableException", 503, "Kiro is unavailable right now. Kiro said: no"],
  ] as const;
  for (const [kind, status, message] of kinds) {
    const said = body({ message: "no" });
    expect(Failure.fromReply(status, said, errortype(kind))).toEqual({ status, message });
    // Kiro's error type decides, whatever the status
    expect(Failure.fromReply(500, said, errortype(kind))).toEqual({ status, message });
    expect(Failure.fromException(kind, said)).toEqual({ status, message });
  }
});

test("an HTTP status with no error type still has its meaning", () => {
  const said = body({ message: "no" });
  expect(Failure.fromReply(429, said)).toEqual({
    status: 429,
    message: "Kiro is rate limiting requests. Kiro said: no",
  });
  expect(Failure.fromReply(401, said)).toEqual({
    status: 401,
    message: `${REFUSED}. Kiro said: no`,
  });
  expect(Failure.fromReply(502, said)).toEqual({
    status: 502,
    message: "Kiro had a server error. Kiro said: no",
  });
});

test("an error Kiro gives no words for still says what it was", () => {
  expect(Failure.fromReply(500, "")).toEqual({ status: 500, message: "Kiro had a server error" });
  expect(Failure.fromReply(418, "")).toEqual({ status: 418, message: "Kiro answered HTTP 418" });
});

test("a stream exception of a kind not known names the kind", () => {
  expect(Failure.fromException("InternalServerException", body({ message: "boom" }))).toEqual({
    status: 500,
    message: "Kiro had a server error. Kiro said: InternalServerException: boom",
  });
  expect(Failure.fromException("error", body({ message: "boom" }))).toEqual({
    status: 500,
    message: "Kiro had a server error. Kiro said: boom",
  });
  expect(Failure.fromException(undefined, "")).toEqual({
    status: 500,
    message: "Kiro had a server error",
  });
});

test("Kiro's words are its message in either spelling, with its reason, or the body as it is", () => {
  const said = (text: string) => Failure.fromReply(400, text).message;
  expect(said(body({ message: "Bad field" }))).toBe(
    "Kiro rejected the request. Kiro said: Bad field"
  );
  expect(said(body({ Message: "Bad field", reason: "INVALID_INPUT" }))).toBe(
    "Kiro rejected the request. Kiro said: Bad field (INVALID_INPUT)"
  );
  expect(said(body({ message: "Bad field", reason: null }))).toBe(
    "Kiro rejected the request. Kiro said: Bad field"
  );
  expect(said("  upstream said no\n")).toBe(
    "Kiro rejected the request. Kiro said: upstream said no"
  );
});

test("Kiro's reasons override its status: too long, spent allowances, no capacity", () => {
  // OpenCode compacts the session on "prompt is too long"
  expect(
    Failure.fromReply(
      400,
      body({ message: "Input is too long.", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" })
    )
  ).toEqual({
    status: 400,
    message:
      "prompt is too long for this model's context window. Kiro said: Input is too long. (CONTENT_LENGTH_EXCEEDS_THRESHOLD)",
  });
  expect(
    Failure.fromException("ValidationException", body({ message: "Input is too long." }))
  ).toEqual({
    status: 400,
    message: "prompt is too long for this model's context window. Kiro said: Input is too long.",
  });
  // and doesn't retry a spent allowance
  expect(Failure.fromReply(429, body({ message: "no", reason: "MONTHLY_REQUEST_COUNT" }))).toEqual({
    status: 402,
    message: "Kiro's monthly usage limit has been reached. Kiro said: no (MONTHLY_REQUEST_COUNT)",
  });
  expect(Failure.fromReply(429, body({ message: "no", reason: "DAILY_REQUEST_COUNT" }))).toEqual({
    status: 402,
    message: "Kiro's daily request limit has been reached. Kiro said: no (DAILY_REQUEST_COUNT)",
  });
  expect(
    Failure.fromReply(429, body({ message: "busy", reason: "INSUFFICIENT_MODEL_CAPACITY" }))
  ).toEqual({
    status: 503,
    message:
      "Kiro has no capacity for this model right now. If it keeps happening, switch models. Kiro said: busy (INSUFFICIENT_MODEL_CAPACITY)",
  });
});

test("Kiro's Retry-After goes on to OpenCode", async () => {
  const failure = Failure.fromReply(429, body({ message: "slow down" }), { "retry-after": "7" });
  expect(failure).toEqual({
    status: 429,
    message: "Kiro is rate limiting requests. Kiro said: slow down",
    retryAfter: "7",
  });
  const res = Failure.toResponse(failure);
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe("7");
  expect(res.headers.get("x-should-retry")).toBeNull();
  expect(await res.json()).toEqual({
    type: "error",
    error: {
      type: "rate_limit_error",
      message: "Kiro is rate limiting requests. Kiro said: slow down",
    },
  });
});

test("the response names the error the way Anthropic does, and says when not to retry", async () => {
  // SAFETY: toResponse writes this shape
  const typeOf = async (status: number) =>
    ((await Failure.toResponse({ status, message: "m" }).json()) as { error: { type: string } })
      .error.type;
  expect(await typeOf(400)).toBe("invalid_request_error");
  expect(await typeOf(401)).toBe("authentication_error");
  expect(await typeOf(402)).toBe("billing_error");
  expect(await typeOf(403)).toBe("permission_error");
  expect(await typeOf(503)).toBe("overloaded_error");
  expect(await typeOf(504)).toBe("api_error");
  const res = Failure.toResponse({ status: 500, message: "m", retry: false });
  expect(res.headers.get("x-should-retry")).toBe("false");
  expect(res.headers.get("content-type")).toBe("application/json");
});

test("an Effect failure is told by what failed", () => {
  const request = HttpClientRequest.get("https://runtime.us-east-1.kiro.dev/");
  const unreachable = new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
  });
  const cases: [unknown, Failure.Failure][] = [
    [Failure.SignInError.make({ message: "sign in" }), { status: 401, message: "sign in" }],
    [Failure.RefreshError.make({ message: "refresh" }), { status: 502, message: "refresh" }],
    [
      Failure.KiroApiError.fromReply(403, body({ message: "Not allowed" })),
      { status: 403, message: "Kiro: Not allowed (HTTP 403)" },
    ],
    [
      new Cause.TimeoutError("kiro.dev didn't answer within 60 seconds"),
      { status: 504, message: "kiro.dev didn't answer within 60 seconds" },
    ],
  ];
  for (const [error, told] of cases)
    expect(Cause.fail(error).pipe(Failure.fromCause)).toEqual(told);
  const offline = Cause.fail(unreachable).pipe(Failure.fromCause);
  expect(offline.status).toBe(502);
  expect(offline.message).toStartWith("Couldn't reach Kiro: ");
  expect(Cause.die(new Error("bug")).pipe(Failure.fromCause)).toEqual({
    status: 500,
    message: "The Kiro plugin failed on this request: bug",
    retry: false,
  });
});

test("a management API answer that isn't OK says Kiro's message and status", () => {
  expect(
    Failure.KiroApiError.fromReply(403, body({ message: "Not allowed", reason: null }))
  ).toEqual(expect.objectContaining({ status: 403, message: "Kiro: Not allowed (HTTP 403)" }));
  expect(Failure.KiroApiError.fromReply(500, "").message).toBe("Kiro answered HTTP 500");
});
