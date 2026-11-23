// What OpenCode is told when Kiro or the network says no, through
// src/failure.ts.

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Schema } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";

import {
  type Failure,
  fromCause,
  fromException,
  fromReply,
  KiroApiError,
  RefreshError,
  SignInError,
  toResponse,
} from "../src/failure.ts";
import { assertStartsWith, assertSubset } from "./assert.ts";
import { toJson } from "./json.ts";

const body = (fields: Schema.JsonObject) => toJson(fields);
const errortype = (kind: string) => ({
  "x-amzn-errortype": `${kind}:http://internal.amazon.com/coral/com.amazon.aws.codewhisperer/`,
});

const ErrorBody = Schema.Struct({
  error: Schema.Struct({ message: Schema.String, type: Schema.String }),
  type: Schema.String,
});
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(ErrorBody));
// bodyOf is the error body a response of toResponse carries
const bodyOf = (res: Response) =>
  Effect.promise(() => res.text()).pipe(Effect.flatMap(decodeBody));
// wordsOf is the message of a 400 whose body is text
const wordsOf = (text: string) => fromReply(400, text).message;
// typeOf is the error type toResponse names a status with
const typeOf = (status: number) =>
  bodyOf(toResponse({ message: "m", status })).pipe(
    Effect.map((written) => written.error.type)
  );

const REFUSED =
  "Kiro refused the request. If you signed out of kiro-cli or switched accounts, run `kiro-cli login`";

describe("failures", () => {
  it.effect(
    "an HTTP answer and a stream exception of the same kind mean the same",
    () =>
      Effect.sync(() => {
        const kinds = [
          [
            "ThrottlingException",
            429,
            "Kiro is rate limiting requests. Kiro said: no",
          ],
          [
            "ValidationException",
            400,
            "Kiro rejected the request. Kiro said: no",
          ],
          ["AccessDeniedException", 403, `${REFUSED}. Kiro said: no`],
          [
            "ServiceUnavailableException",
            503,
            "Kiro is unavailable right now. Kiro said: no",
          ],
        ] as const;
        for (const [kind, status, message] of kinds) {
          const said = body({ message: "no" });
          assert.deepStrictEqual(fromReply(status, said, errortype(kind)), {
            message,
            status,
          });
          // Kiro's error type decides, whatever the status
          assert.deepStrictEqual(fromReply(500, said, errortype(kind)), {
            message,
            status,
          });
          assert.deepStrictEqual(fromException(kind, said), {
            message,
            status,
          });
        }
      })
  );

  it.effect("an HTTP status with no error type still has its meaning", () =>
    Effect.sync(() => {
      const said = body({ message: "no" });
      assert.deepStrictEqual(fromReply(429, said), {
        message: "Kiro is rate limiting requests. Kiro said: no",
        status: 429,
      });
      assert.deepStrictEqual(fromReply(401, said), {
        message: `${REFUSED}. Kiro said: no`,
        status: 401,
      });
      assert.deepStrictEqual(fromReply(502, said), {
        message: "Kiro had a server error. Kiro said: no",
        status: 502,
      });
    })
  );

  it.effect("an error Kiro gives no words for still says what it was", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(fromReply(500, ""), {
        message: "Kiro had a server error",
        status: 500,
      });
      assert.deepStrictEqual(fromReply(418, ""), {
        message: "Kiro answered HTTP 418",
        status: 418,
      });
    })
  );

  it.effect("a stream exception of a kind not known names the kind", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        fromException("InternalServerException", body({ message: "boom" })),
        {
          message:
            "Kiro had a server error. Kiro said: InternalServerException: boom",
          status: 500,
        }
      );
      assert.deepStrictEqual(
        fromException("error", body({ message: "boom" })),
        {
          message: "Kiro had a server error. Kiro said: boom",
          status: 500,
        }
      );
      assert.deepStrictEqual(fromException(undefined, ""), {
        message: "Kiro had a server error",
        status: 500,
      });
    })
  );

  it.effect(
    "Kiro's words are its message in either spelling, with its reason, or the body as it is",
    () =>
      Effect.sync(() => {
        assert.strictEqual(
          wordsOf(body({ message: "Bad field" })),
          "Kiro rejected the request. Kiro said: Bad field"
        );
        assert.strictEqual(
          wordsOf(body({ Message: "Bad field", reason: "INVALID_INPUT" })),
          "Kiro rejected the request. Kiro said: Bad field (INVALID_INPUT)"
        );
        assert.strictEqual(
          wordsOf(body({ message: "Bad field", reason: null })),
          "Kiro rejected the request. Kiro said: Bad field"
        );
        assert.strictEqual(
          wordsOf("  upstream said no\n"),
          "Kiro rejected the request. Kiro said: upstream said no"
        );
      })
  );

  it.effect(
    "Kiro's reasons override its status: too long, spent allowances, no capacity",
    () =>
      Effect.sync(() => {
        // OpenCode compacts the session on "prompt is too long"
        assert.deepStrictEqual(
          fromReply(
            400,
            body({
              message: "Input is too long.",
              reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
            })
          ),
          {
            message:
              "prompt is too long for this model's context window. Kiro said: Input is too long. (CONTENT_LENGTH_EXCEEDS_THRESHOLD)",
            status: 400,
          }
        );
        assert.deepStrictEqual(
          fromException(
            "ValidationException",
            body({ message: "Input is too long." })
          ),
          {
            message:
              "prompt is too long for this model's context window. Kiro said: Input is too long.",
            status: 400,
          }
        );
        // and doesn't retry a spent allowance
        assert.deepStrictEqual(
          fromReply(
            429,
            body({ message: "no", reason: "MONTHLY_REQUEST_COUNT" })
          ),
          {
            message:
              "Kiro's monthly usage limit has been reached. Kiro said: no (MONTHLY_REQUEST_COUNT)",
            status: 402,
          }
        );
        assert.deepStrictEqual(
          fromReply(
            429,
            body({ message: "no", reason: "DAILY_REQUEST_COUNT" })
          ),
          {
            message:
              "Kiro's daily request limit has been reached. Kiro said: no (DAILY_REQUEST_COUNT)",
            status: 402,
          }
        );
        assert.deepStrictEqual(
          fromReply(
            429,
            body({ message: "busy", reason: "INSUFFICIENT_MODEL_CAPACITY" })
          ),
          {
            message:
              "Kiro has no capacity for this model right now. If it keeps happening, switch models. Kiro said: busy (INSUFFICIENT_MODEL_CAPACITY)",
            status: 503,
          }
        );
      })
  );

  it.effect("Kiro's Retry-After goes on to OpenCode", () =>
    Effect.gen(function* () {
      const failure = fromReply(429, body({ message: "slow down" }), {
        "retry-after": "7",
      });
      assert.deepStrictEqual(failure, {
        message: "Kiro is rate limiting requests. Kiro said: slow down",
        retryAfter: "7",
        status: 429,
      });
      const res = toResponse(failure);
      assert.strictEqual(res.status, 429);
      assert.strictEqual(res.headers.get("retry-after"), "7");
      assert.isNull(res.headers.get("x-should-retry"));
      const written = yield* bodyOf(res);
      assert.deepStrictEqual(written, {
        error: {
          message: "Kiro is rate limiting requests. Kiro said: slow down",
          type: "rate_limit_error",
        },
        type: "error",
      });
    })
  );

  it.effect(
    "the response names the error the way Anthropic does, and says when not to retry",
    () =>
      Effect.gen(function* () {
        const type = yield* typeOf(400);
        assert.strictEqual(type, "invalid_request_error");
        const type2 = yield* typeOf(401);
        assert.strictEqual(type2, "authentication_error");
        const type3 = yield* typeOf(402);
        assert.strictEqual(type3, "billing_error");
        const type4 = yield* typeOf(403);
        assert.strictEqual(type4, "permission_error");
        const type5 = yield* typeOf(503);
        assert.strictEqual(type5, "overloaded_error");
        const type6 = yield* typeOf(504);
        assert.strictEqual(type6, "api_error");
        const res = toResponse({ message: "m", retry: false, status: 500 });
        assert.strictEqual(res.headers.get("x-should-retry"), "false");
        assert.strictEqual(res.headers.get("content-type"), "application/json");
      })
  );

  it.effect("an Effect failure is told by what failed", () =>
    Effect.sync(() => {
      const request = HttpClientRequest.get(
        "https://runtime.us-east-1.kiro.dev/"
      );
      const unreachable = new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          description: "connection refused",
          request,
        }),
      });
      const cases: Array<[unknown, Failure]> = [
        [
          SignInError.make({ message: "sign in" }),
          { message: "sign in", status: 401 },
        ],
        [
          RefreshError.make({ message: "refresh" }),
          { message: "refresh", status: 502 },
        ],
        [
          KiroApiError.fromReply(403, body({ message: "Not allowed" })),
          { message: "Kiro: Not allowed (HTTP 403)", status: 403 },
        ],
        [
          new Cause.TimeoutError("kiro.dev didn't answer within 60 seconds"),
          { message: "kiro.dev didn't answer within 60 seconds", status: 504 },
        ],
      ];
      for (const [error, told] of cases) {
        assert.deepStrictEqual(Cause.fail(error).pipe(fromCause), told);
      }
      const offline = Cause.fail(unreachable).pipe(fromCause);
      assert.strictEqual(offline.status, 502);
      assertStartsWith(offline.message, "Couldn't reach Kiro: ");
      assert.deepStrictEqual(Cause.die(new Error("bug")).pipe(fromCause), {
        message: "The Kiro plugin failed on this request: bug",
        retry: false,
        status: 500,
      });
    })
  );

  it.effect(
    "a management API answer that isn't OK says Kiro's message and status",
    () =>
      Effect.sync(() => {
        assertSubset(
          KiroApiError.fromReply(
            403,
            body({ message: "Not allowed", reason: null })
          ),
          { message: "Kiro: Not allowed (HTTP 403)", status: 403 }
        );
        assert.strictEqual(
          KiroApiError.fromReply(500, "").message,
          "Kiro answered HTTP 500"
        );
      })
  );
});
