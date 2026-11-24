// The Kiro account through src/account.ts's KiroAccount: the sign-in it
// reads, refreshes and writes back, and what it asks Kiro's management API.
// HOME is a throwaway dir and PATH is empty (see signin.ts); HTTP goes to
// the fake network (see network.ts). The sign-ins' expiries are wall clock
// times, so the tests that read them run on the live clock.

import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  DateTime,
  Effect,
  Fiber,
  Layer,
  type Schema,
} from "effect";
import { type HttpClientRequest, UrlParams } from "effect/http";
import { TestClock } from "effect/testing";

import { KiroAccount } from "../src/account.ts";
import { assertStartsWith, assertSubset } from "./assert.ts";
import { toJson } from "./json.ts";
import {
  fakeNetwork,
  offline,
  param,
  pathOf,
  recording,
  reply,
  textOf,
  unanswered,
} from "./network.ts";
import { isoAt, nowMs, PROFILE, throwawayHome } from "./signin.ts";

const {
  ideTempLeft,
  installKiroCli,
  kiroCli,
  readOnly,
  removeKiroCli,
  signIn,
  signInIDE,
  signOut,
  stored,
  storedIDE,
} = throwawayHome();

const net = fakeNetwork();
const layer = KiroAccount.layer.pipe(Layer.provide(net.layer));
// run runs effect on an account of its own, the network offline after
const run = <A, E>(effect: Effect.Effect<A, E, KiroAccount>) =>
  effect.pipe(Effect.provide(layer), net.reset);

// the account's credentials, or why there are none
const credentials = (rejected?: string) =>
  run(Effect.flatMap(KiroAccount, (account) => account.credentials(rejected)));
const credentialsError = (rejected?: string) =>
  run(
    Effect.flip(
      Effect.flatMap(KiroAccount, (account) => account.credentials(rejected))
    )
  );
const OIDC = "https://oidc.us-east-1.amazonaws.com/token";
const SOON = () => nowMs() + 30_000;

// ide is the Kiro IDE's Identity Center token file
const ide = (accessToken: string, refreshToken: string, expires: number) => ({
  accessToken,
  authMethod: "IdC",
  clientIdHash: "h",
  expiresAt: isoAt(expires),
  profileArn: PROFILE,
  provider: "Enterprise",
  refreshToken,
  region: "us-east-1",
});

// twice is the credentials two calls on one account get
const twice = () =>
  run(
    Effect.gen(function* () {
      const account = yield* KiroAccount;
      return [yield* account.credentials(), yield* account.credentials()];
    })
  );

describe("sign-in and refresh", () => {
  it.live(
    "reads kiro-cli's sign-in, with the profile kiro-cli keeps apart from the token",
    () =>
      Effect.gen(function* () {
        signIn();
        const auth = yield* credentials();
        assert.deepStrictEqual(auth, {
          profile: PROFILE,
          region: "us-east-1",
          token: "old",
          tokenType: "",
        });
      })
  );

  it.live(
    "a token near its end is refreshed at AWS and written back for kiro-cli",
    () =>
      Effect.gen(function* () {
        signIn({ expires: SOON() });
        const seen: Array<[string, unknown]> = [];
        net.answer = recording(
          (request, body) => {
            seen.push([request.url, body]);
          },
          { accessToken: "new", expiresIn: 3600, refreshToken: "r2" }
        );
        const auth = yield* credentials();
        assertSubset(auth, {
          profile: PROFILE,
          region: "us-east-1",
          token: "new",
        });
        assert.deepStrictEqual(seen, [
          [
            OIDC,
            {
              clientId: "cid",
              clientSecret: "secret",
              grantType: "refresh_token",
              refreshToken: "r1",
            },
          ],
        ]);
        // written back with the fields kiro-cli keeps that the plugin doesn't read
        const token = yield* stored();
        assertSubset(token, {
          access_token: "new",
          refresh_token: "r2",
          scopes: ["codewhisperer:conversations"],
        });
      })
  );

  it.live(
    "a Google or GitHub sign-in is refreshed the way the Kiro IDE does, and keeps the profile Kiro gives",
    () =>
      Effect.gen(function* () {
        kiroCli([
          {
            key: "kirocli:social:token",
            value: {
              access_token: "old",
              expires_at: isoAt(SOON()),
              provider: "Google",
              refresh_token: "r1",
              region: "us-east-1",
            },
          },
        ]);
        const seen: Array<{
          body: unknown;
          ua: string | undefined;
          url: string;
        }> = [];
        net.answer = recording(
          (request, body) => {
            seen.push({
              body,
              ua: request.headers["user-agent"],
              url: request.url,
            });
          },
          {
            accessToken: "new",
            expiresIn: 3600,
            profileArn:
              "arn:aws:codewhisperer:us-east-1:333333333333:profile/SOCIAL",
            refreshToken: "r2",
          }
        );
        const auth = yield* credentials();
        assert.deepStrictEqual(auth, {
          profile:
            "arn:aws:codewhisperer:us-east-1:333333333333:profile/SOCIAL",
          region: "us-east-1",
          token: "new",
          tokenType: "",
        });
        assert.deepStrictEqual(seen, [
          {
            body: { refreshToken: "r1" },
            ua: "Kiro-Desktop/0.2.13 (darwin; arm64)",
            url: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
          },
        ]);
        const token = yield* stored("kirocli:social:token");
        assertSubset(token, {
          access_token: "new",
          profile_arn:
            "arn:aws:codewhisperer:us-east-1:333333333333:profile/SOCIAL",
          provider: "Google",
          refresh_token: "r2",
        });
      })
  );

  it.live(
    "a company's own identity provider is refreshed at its token endpoint, and its calls say so",
    () =>
      Effect.gen(function* () {
        const profile =
          "arn:aws:codewhisperer:us-east-1:444444444444:profile/IDP";
        kiroCli([
          {
            key: "kirocli:external-idp:token",
            value: {
              access_token: "old",
              client_id: "idp-client",
              expires_at: isoAt(SOON()),
              issuer_url: "https://login.example.com/oauth2/",
              profile_arn: profile,
              refresh_token: "r1",
              region: "us-east-1",
            },
          },
        ]);
        const seen: Array<{
          body: string;
          type: string | undefined;
          url: string;
        }> = [];
        net.answer = (request) => {
          const query = UrlParams.toString(request.urlParams);
          seen.push({
            body: textOf(request),
            type: request.headers.tokentype,
            url: request.url + (query === "" ? "" : `?${query}`),
          });
          if (pathOf(request) === "/Get-Usage-Limits") {
            return reply({});
          }
          return reply({
            access_token: "new",
            expires_in: 3600,
            refresh_token: "r2",
          });
        };
        yield* run(Effect.flatMap(KiroAccount, (account) => account.usage));
        assert.deepStrictEqual(seen, [
          {
            body: "client_id=idp-client&grant_type=refresh_token&refresh_token=r1",
            type: undefined,
            url: "https://login.example.com/oauth2/v1/token",
          },
          {
            body: "",
            type: "EXTERNAL_IDP",
            url: "https://management.us-east-1.kiro.dev/Get-Usage-Limits?origin=KIRO_CLI&profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A444444444444%3Aprofile%2FIDP&resourceType=CREDIT",
          },
        ]);
        const token = yield* stored("kirocli:external-idp:token");
        assertSubset(token, {
          access_token: "new",
          client_id: "idp-client",
          refresh_token: "r2",
        });
      })
  );

  it.live(
    "the Kiro IDE's sign-in is refreshed with its client and written back to its file",
    () =>
      Effect.gen(function* () {
        signOut();
        signInIDE(
          {
            accessToken: "old",
            authMethod: "IdC",
            clientIdHash: "h",
            expiresAt: isoAt(SOON()),
            profileArn: PROFILE,
            provider: "Enterprise",
            refreshToken: "r1",
            region: "us-east-1",
          },
          { clientId: "c", clientSecret: "s" }
        );
        const seen: Array<unknown> = [];
        net.answer = recording(
          (_request, body) => {
            seen.push(body);
          },
          { accessToken: "new", expiresIn: 3600, refreshToken: "r2" }
        );
        const auth = yield* credentials();
        assertSubset(auth, { profile: PROFILE, token: "new" });
        assert.deepStrictEqual(seen, [
          {
            clientId: "c",
            clientSecret: "s",
            grantType: "refresh_token",
            refreshToken: "r1",
          },
        ]);
        const token = yield* storedIDE();
        assertSubset(token, {
          accessToken: "new",
          clientIdHash: "h",
          provider: "Enterprise",
          refreshToken: "r2",
        });
        assert.isFalse(ideTempLeft());
        signOut();
      })
  );

  it.live(
    "a sign-in kiro-cli took while a refresh was out is kept, and used next",
    () =>
      Effect.gen(function* () {
        signIn({ expires: SOON() });
        net.answer = () => {
          // the user signs in again before AWS answers the plugin's refresh
          signIn({ access: "other", refresh: "r-other" });
          return reply({
            accessToken: "new",
            expiresIn: 3600,
            refreshToken: "r2",
          });
        };
        const [first, next] = yield* twice();
        assertSubset(first, { token: "new" });
        const token = yield* stored();
        assertSubset(token, {
          access_token: "other",
          refresh_token: "r-other",
        });
        assertSubset(next, { token: "other" });
      })
  );

  it.live(
    "a sign-in the Kiro IDE took while a refresh was out is kept, and used next",
    () =>
      Effect.gen(function* () {
        signOut();
        signInIDE(ide("old", "r1", SOON()), {
          clientId: "c",
          clientSecret: "s",
        });
        net.answer = () => {
          signInIDE(ide("other", "r-other", nowMs() + 60 * 60_000));
          return reply({
            accessToken: "new",
            expiresIn: 3600,
            refreshToken: "r2",
          });
        };
        const [first, next] = yield* twice();
        assertSubset(first, { token: "new" });
        const token = yield* storedIDE();
        assertSubset(token, {
          accessToken: "other",
          refreshToken: "r-other",
        });
        assert.isFalse(ideTempLeft());
        assertSubset(next, { token: "other" });
        signOut();
      })
  );

  it.live(
    "one refresh at a time: two requests at once spend the refresh token once",
    () =>
      Effect.gen(function* () {
        signIn({ expires: nowMs() - 1000 });
        const refreshes: Array<unknown> = [];
        const answer = recording(
          (_request, body) => {
            refreshes.push(body);
          },
          { accessToken: "new", expiresIn: 3600, refreshToken: "r2" }
        );
        net.answer = (request) =>
          answer(request).pipe(Effect.tap(() => Effect.sleep("30 millis")));
        const both = yield* run(
          Effect.gen(function* () {
            const account = yield* KiroAccount;
            return yield* Effect.all(
              [account.credentials(), account.credentials()],
              { concurrency: 2 }
            );
          })
        );
        assert.deepStrictEqual(
          Arr.map(both, (auth) => auth.token),
          ["new", "new"]
        );
        assert.lengthOf(refreshes, 1);
      })
  );

  it.live(
    "a refresh whose write-back failed isn't repeated with the refresh token it spent",
    () =>
      Effect.gen(function* () {
        signIn({ expires: nowMs() - 1000 });
        const refreshes: Array<unknown> = [];
        net.answer = recording(
          (_request, body) => {
            refreshes.push(body);
          },
          { accessToken: "new", expiresIn: 3600, refreshToken: "r2" }
        );
        // a database the plugin may read but not write: the write-back can't land
        const tokens = yield* Effect.acquireUseRelease(
          Effect.sync(() => readOnly(true)),
          () =>
            run(
              Effect.gen(function* () {
                const account = yield* KiroAccount;
                const first = yield* account.credentials();
                const second = yield* account.credentials();
                return [first.token, second.token];
              })
            ),
          () => Effect.sync(() => readOnly(false))
        );
        assert.deepStrictEqual(tokens, ["new", "new"]);
        assert.lengthOf(refreshes, 1);
        const token = yield* stored();
        assertSubset(token, { access_token: "old" });
      })
  );

  it.live(
    "a refresh that fails says why: a refused one asks for a sign-in, another is retried",
    () =>
      Effect.gen(function* () {
        signIn({ expires: nowMs() - 1000 });
        for (const status of [400, 401, 403]) {
          net.answer = () => reply({ error: "invalid_grant" }, { status });
          const error = yield* credentialsError();
          assertSubset(error, {
            _tag: "SignInError",
            message:
              "Kiro's sign-in has expired. Run `kiro-cli login`, then try again.",
          });
        }
        net.answer = () => Effect.succeed(new Response("", { status: 503 }));
        const error2 = yield* credentialsError();
        assertSubset(error2, {
          _tag: "RefreshError",
          message:
            "Couldn't refresh Kiro's sign-in: oidc.us-east-1.amazonaws.com answered HTTP 503",
        });
        net.answer = offline;
        const unreachable = yield* credentialsError();
        assertSubset(unreachable, { _tag: "RefreshError" });
        assertStartsWith(
          unreachable.message,
          "Couldn't refresh Kiro's sign-in: "
        );
        // with no refresh token there is nothing to ask AWS with
        signIn({ expires: nowMs() - 1000, refresh: "" });
        net.answer = () => unanswered("AWS was asked");
        const error3 = yield* credentialsError();
        assertSubset(error3, { _tag: "SignInError" });
      })
  );
});

// stalled is an answer whose headers arrive and whose body never ends
const stalled = () =>
  Effect.succeed(
    new Response(new ReadableStream(), {
      headers: { "content-type": "application/json" },
    })
  );
// what the account runs beside the test needs a moment of real time
const settle = TestClock.withLive(Effect.sleep("10 millis"));

// failsAfter runs failing on TestClock and says whether it had failed one
// second before seconds, and how it failed at seconds
const failsAfter = <A, E>(
  seconds: number,
  failing: Effect.Effect<A, E, KiroAccount>
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.flip(failing));
    yield* settle;
    yield* TestClock.adjust(`${seconds - 1} seconds`);
    yield* settle;
    const early = fiber.pollUnsafe();
    yield* TestClock.adjust("1 second");
    return { early, error: yield* Fiber.join(fiber) };
  });

describe("deadlines", () => {
  it.effect(
    "a token endpoint that stalls in its body fails the refresh after 30 seconds, and blocks nothing after",
    () =>
      Effect.gen(function* () {
        signIn();
        net.answer = stalled;
        const out = yield* run(
          Effect.gen(function* () {
            const account = yield* KiroAccount;
            const failed = yield* failsAfter(30, account.credentials("old"));
            return { ...failed, next: yield* account.credentials() };
          })
        );
        assert.isUndefined(out.early);
        assertSubset(out.error, {
          _tag: "RefreshError",
          message:
            "Couldn't refresh Kiro's sign-in: oidc.us-east-1.amazonaws.com didn't answer within 30 seconds",
        });
        assertSubset(out.next, { token: "old" });
      })
  );

  it.effect(
    "a management call that stalls in its body fails after 20 seconds as Kiro's 502",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        net.answer = stalled;
        const out = yield* run(
          Effect.flatMap(KiroAccount, (account) =>
            failsAfter(20, account.usage)
          )
        );
        assert.isUndefined(out.early);
        assertSubset(out.error, {
          _tag: "KiroApiError",
          message:
            "Couldn't reach Kiro for Get-Usage-Limits: management.us-east-1.kiro.dev didn't answer within 20 seconds",
          status: 502,
        });
      })
  );
});

// A Builder ID sign-in has no profile of its own and Kiro won't list one for
// it; it is asked with the service profile kiro-cli and the IDE use
// (magpie-community/plugins#16: a Kiro Student account was offered Auto alone).
const BUILDER_ID =
  "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
const IDC = "arn:aws:codewhisperer:us-east-1:222222222222:profile/IDC";
const STUDENT = [
  { modelId: "auto", modelName: "auto" },
  { modelId: "claude-opus-5.5", modelName: "claude-opus-5.5" },
];

// management is Kiro's management API as a sign-in with no profile sees it:
// profiles listed (or a 403 for Builder ID), and models only for a profile
function management(profiles?: Array<{ arn: string }>) {
  const listedWith: Array<string | undefined> = [];
  const seen = { listedWith, profiles: 0 };
  net.answer = (request: HttpClientRequest.HttpClientRequest) => {
    if (pathOf(request) === "/List-Available-Profiles") {
      seen.profiles += 1;
      if (profiles !== undefined) {
        return reply({ profiles });
      }
      const message = "AWS Builder ID is not supported for this operation";
      return reply({ message, reason: null }, { status: 403 });
    }
    if (pathOf(request) === "/List-Available-Models") {
      const profile = param(request, "profileArn");
      seen.listedWith.push(profile);
      if (profile === BUILDER_ID || profile === IDC) {
        return reply({ models: STUDENT });
      }
      return reply({ message: "profileArn is required" }, { status: 400 });
    }
    return unanswered(`unexpected request to ${request.url}`);
  };
  return seen;
}

// withKiroCli runs effect with a kiro-cli in the throwaway HOME's
// ~/.local/bin, where the plugin looks with PATH empty. Its
// `debug refresh-auth-token` writes token as kiro-cli's sign-in.
const withKiroCli = <A, E, R>(
  token: Schema.JsonObject,
  effect: Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => installKiroCli(token)),
    () => effect,
    () => Effect.sync(removeKiroCli)
  );
const cliToken = (access: string, refresh: string) => ({
  access_token: access,
  expires_at: isoAt(nowMs() + 60 * 60_000),
  refresh_token: refresh,
  region: "us-east-1",
  start_url: "https://example.awsapps.com/start",
});
// an expiry long past
const RAN_OUT = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-01-01T00:00:00Z")
);

describe("the profile and region", () => {
  it.live(
    "kiro-cli's Builder ID sign-in (its start URL, or none) is asked with Builder ID's profile",
    () =>
      Effect.gen(function* () {
        for (const start of ["https://view.awsapps.com/start", null]) {
          signIn({ profile: null, start });
          const seen = management();
          const auth = yield* credentials();
          assertSubset(auth, {
            profile: BUILDER_ID,
            region: "us-east-1",
          });
          assert.strictEqual(seen.profiles, 0);
        }
      })
  );

  it.live(
    "a Builder ID account's own models are listed under Builder ID's profile",
    () =>
      Effect.gen(function* () {
        signIn({ profile: null, start: null });
        const seen = management();
        const models = yield* run(
          Effect.flatMap(KiroAccount, (account) => account.models)
        );
        assert.deepStrictEqual(seen.listedWith, [BUILDER_ID]);
        assert.deepStrictEqual(
          Arr.map(models, (model) => [model.id, model.name]),
          [
            ["auto", "Auto"],
            ["claude-opus-5.5", "claude-opus-5.5"],
          ]
        );
      })
  );

  it.live(
    "an Identity Center sign-in with no profile has its own listed, once",
    () =>
      Effect.gen(function* () {
        signIn({ profile: null });
        const seen = management([{ arn: IDC }]);
        const both = yield* twice();
        assert.deepStrictEqual(
          Arr.map(both, (auth) => auth.profile),
          [IDC, IDC]
        );
        assert.strictEqual(seen.profiles, 1);
      })
  );

  it.live(
    "an account signed into in place of another has its own profile listed",
    () =>
      Effect.gen(function* () {
        const OTHER =
          "arn:aws:codewhisperer:us-east-1:666666666666:profile/OTHER";
        signIn({ profile: null });
        const asked: Array<string | undefined> = [];
        net.answer = (request) => {
          const token = request.headers.authorization;
          asked.push(token);
          return reply({
            profiles: [{ arn: token === "Bearer b" ? OTHER : IDC }],
          });
        };
        const both = yield* run(
          Effect.gen(function* () {
            const account = yield* KiroAccount;
            const first = yield* account.credentials();
            yield* Effect.sync(() =>
              signIn({ access: "b", profile: null, refresh: "rb" })
            );
            return [first, yield* account.credentials()];
          })
        );
        assert.deepStrictEqual(
          Arr.map(both, (auth) => [auth.token, auth.profile]),
          [
            ["old", IDC],
            ["b", OTHER],
          ]
        );
        assert.deepStrictEqual(asked, ["Bearer old", "Bearer b"]);
      })
  );

  it.live(
    "a profile listed for a sign-in is kept when a refresh replaces its refresh token",
    () =>
      Effect.gen(function* () {
        signIn({ expires: SOON(), profile: null });
        let listed = 0;
        let refreshes = 0;
        net.answer = (request) => {
          if (pathOf(request) === "/List-Available-Profiles") {
            listed += 1;
            return reply({ profiles: [{ arn: IDC }] });
          }
          refreshes += 1;
          return reply({
            accessToken: `new${refreshes}`,
            expiresIn: 3600,
            refreshToken: `r${refreshes + 1}`,
          });
        };
        const both = yield* run(
          Effect.gen(function* () {
            const account = yield* KiroAccount;
            return [
              yield* account.credentials(),
              yield* account.credentials("new1"),
            ];
          })
        );
        assert.deepStrictEqual(
          Arr.map(both, (auth) => [auth.token, auth.profile]),
          [
            ["new1", IDC],
            ["new2", IDC],
          ]
        );
        assert.strictEqual(listed, 1);
      })
  );

  it.live(
    "a sign-in kiro-cli swaps in while it refreshes has its own profile listed",
    () =>
      Effect.gen(function* () {
        const OTHER =
          "arn:aws:codewhisperer:us-east-1:666666666666:profile/OTHER";
        signIn({ profile: null });
        const asked: Array<string | undefined> = [];
        net.answer = (request) => {
          const token = request.headers.authorization;
          asked.push(token);
          return reply({
            profiles: [{ arn: token === "Bearer b" ? OTHER : IDC }],
          });
        };
        const both = yield* withKiroCli(
          cliToken("b", "rb"),
          run(
            Effect.gen(function* () {
              const account = yield* KiroAccount;
              const first = yield* account.credentials();
              // the same sign-in, run out
              yield* Effect.sync(() =>
                signIn({ expires: RAN_OUT, profile: null })
              );
              return [first, yield* account.credentials()];
            })
          )
        );
        assert.deepStrictEqual(
          Arr.map(both, (auth) => [auth.token, auth.profile]),
          [
            ["old", IDC],
            ["b", OTHER],
          ]
        );
        assert.deepStrictEqual(asked, ["Bearer old", "Bearer b"]);
      })
  );

  it.live("a sign-in kiro-cli refreshes keeps the profile listed for it", () =>
    Effect.gen(function* () {
      signIn({ profile: null });
      const asked: Array<string | undefined> = [];
      net.answer = (request) => {
        asked.push(request.headers.authorization);
        return reply({ profiles: [{ arn: IDC }] });
      };
      const both = yield* withKiroCli(
        cliToken("a2", "r1"),
        run(
          Effect.gen(function* () {
            const account = yield* KiroAccount;
            const first = yield* account.credentials();
            yield* Effect.sync(() =>
              signIn({ expires: RAN_OUT, profile: null })
            );
            return [first, yield* account.credentials()];
          })
        )
      );
      assert.deepStrictEqual(
        Arr.map(both, (auth) => [auth.token, auth.profile]),
        [
          ["old", IDC],
          ["a2", IDC],
        ]
      );
      assert.deepStrictEqual(asked, ["Bearer old"]);
    })
  );

  it.live(
    "an AWS sign-in whose profiles Kiro won't list for Builder ID takes Builder ID's profile",
    () =>
      Effect.gen(function* () {
        signIn({ profile: null });
        const seen = management();
        const auth = yield* credentials();
        assertSubset(auth, { profile: BUILDER_ID });
        assert.strictEqual(seen.profiles, 1);
      })
  );

  it.live(
    "the Kiro IDE's Builder ID sign-in is asked with Builder ID's profile",
    () =>
      Effect.gen(function* () {
        signOut();
        signInIDE(
          {
            accessToken: "ide",
            authMethod: "IdC",
            clientIdHash: "h",
            expiresAt: isoAt(nowMs() + 60 * 60_000),
            provider: "BuilderId",
            refreshToken: "r",
            region: "us-east-1",
          },
          { clientId: "c", clientSecret: "s" }
        );
        const seen = management();
        const auth = yield* credentials();
        assertSubset(auth, {
          profile: BUILDER_ID,
          token: "ide",
        });
        assert.strictEqual(seen.profiles, 0);
        signOut();
      })
  );

  it.live(
    "an account's API is in its profile's region, else the one of Kiro's nearer its sign-in",
    () =>
      Effect.gen(function* () {
        const EU = "arn:aws:codewhisperer:eu-central-1:555555555555:profile/EU";
        // an Identity Center sign-in in Europe, its profile listed in eu-central-1
        signIn({ profile: null, region: "eu-west-1" });
        const asked: Array<string> = [];
        net.answer = (request) => {
          const url = new URL(request.url);
          asked.push(url.host + url.pathname);
          if (url.pathname === "/Get-Usage-Limits") {
            return reply({});
          }
          if (url.host === "management.eu-central-1.kiro.dev") {
            return reply({ profiles: [{ arn: EU }] });
          }
          return reply({ profiles: [] });
        };
        const listed = yield* run(
          Effect.gen(function* () {
            const account = yield* KiroAccount;
            const auth = yield* account.credentials();
            yield* account.usage;
            return auth;
          })
        );
        assertSubset(listed, { profile: EU, region: "eu-central-1" });
        assert.deepStrictEqual(asked, [
          "management.us-east-1.kiro.dev/List-Available-Profiles",
          "management.eu-central-1.kiro.dev/List-Available-Profiles",
          "management.eu-central-1.kiro.dev/Get-Usage-Limits",
        ]);
        // a profile that names no region: Kiro's region nearer the sign-in
        signIn({ profile: "EU", region: "eu-west-1" });
        const auth = yield* credentials();
        assertSubset(auth, {
          profile: "EU",
          region: "eu-central-1",
        });
        signIn({ profile: "AP", region: "ap-south-1" });
        const auth2 = yield* credentials();
        assertSubset(auth2, {
          profile: "AP",
          region: "us-east-1",
        });
      })
  );

  it.live(
    "with no sign-in, there are no credentials and nothing is asked",
    () =>
      Effect.gen(function* () {
        signOut();
        const error = yield* credentialsError();
        assertSubset(error, {
          _tag: "SignInError",
          message:
            "Kiro isn't signed in. Run `kiro-cli login`, then try again.",
        });
      })
  );
});

// Get-Usage-Limits as Kiro answered it (2026-10-28) for a Kiro Pro account
// over its limit, the user's own details made up
const PRO_USAGE = {
  daysUntilReset: null,
  limits: null,
  nextDateReset: 1_793_491_200,
  overageConfiguration: { overageStatus: "ENABLED" },
  subscriptionInfo: {
    overageCapability: "OVERAGE_CAPABLE",
    subscriptionManagementTarget: "MANAGE",
    subscriptionTitle: "KIRO PRO",
    type: "Q_DEVELOPER_STANDALONE_PRO",
    upgradeCapability: "UPGRADE_INCAPABLE",
  },
  usageBreakdownList: [
    {
      bonuses: [],
      currency: "USD",
      currentOverages: 7978,
      currentOveragesWithPrecision: 7978.62,
      currentUsage: 8978,
      currentUsageWithPrecision: 8978.62,
      displayName: "Credit",
      displayNamePlural: "Credits",
      freeTrialInfo: null,
      nextDateReset: 1_793_491_200,
      overageCap: 40_000,
      overageCapWithPrecision: 40_000,
      overageCharges: 319.144848378096,
      overageCredits: [],
      overageRate: 0.04,
      resourceType: "CREDIT",
      unit: "INVOCATIONS",
      usageLimit: 1000,
      usageLimitWithPrecision: 1000,
    },
  ],
  userInfo: { email: "someone@example.com", userId: "user-1" },
};

// usageAnswering is the account's usage with Kiro answering Get-Usage-Limits
// with limits, and the queries it was asked with
const usageAnswering = Effect.fnUntraced(function* (limits: Schema.JsonObject) {
  const asked: Array<Record<string, string | Array<string>>> = [];
  net.answer = (request) => {
    if (pathOf(request) !== "/Get-Usage-Limits") {
      return unanswered(`unexpected ${request.url}`);
    }
    asked.push(UrlParams.toRecord(request.urlParams));
    return reply(limits);
  };
  const usage = yield* run(
    Effect.flatMap(KiroAccount, (account) => account.usage)
  );
  return { asked, usage };
});

// trial is a Credits allowance whose active trial expires at freeTrialExpiry
const trial = (freeTrialExpiry: string | number) => ({
  displayNamePlural: "Credits",
  freeTrialInfo: {
    freeTrialExpiry,
    freeTrialStatus: "ACTIVE",
    usageLimit: 500,
  },
  usageLimitWithPrecision: 50,
});

describe("the management API", () => {
  it.live(
    "models: every page is listed, the default first, and one in a shape not known is left out",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const asked: Array<string | undefined> = [];
        net.answer = (request) => {
          const page = param(request, "nextToken");
          asked.push(page);
          if (page === undefined || page === "") {
            return reply({
              defaultModel: { modelId: "claude-b" },
              models: [
                { modelId: "claude-a", modelName: "Claude A" },
                { modelName: "no id" },
              ],
              nextToken: "p2",
            });
          }
          return reply({
            models: [{ modelId: "claude-b", modelName: "Claude B" }],
          });
        };
        const models = yield* run(
          Effect.flatMap(KiroAccount, (account) => account.models)
        );
        assert.deepStrictEqual(asked, [undefined, "p2"]);
        assert.deepStrictEqual(
          Arr.map(models, (model) => model.id),
          ["claude-b", "claude-a"]
        );
      })
  );

  it.live("models: a listing with none in it is Kiro's failure", () =>
    Effect.gen(function* () {
      signIn({ access: "tok" });
      net.answer = () => reply({ models: [] });
      const error = yield* run(
        Effect.flip(Effect.flatMap(KiroAccount, (account) => account.models))
      );
      assertSubset(error, {
        _tag: "KiroApiError",
        message: "Kiro listed no models",
        status: 502,
      });
    })
  );

  it.live(
    "usage: Get-Usage-Limits reads as the plan, its credits and the overage, and nothing of the user",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const { asked, usage } = yield* usageAnswering(PRO_USAGE);
        assert.deepStrictEqual(asked, [
          { origin: "KIRO_CLI", profileArn: PROFILE, resourceType: "CREDIT" },
        ]);
        const { checkedAt, ...rest } = usage;
        assert.isNumber(checkedAt);
        assert.deepStrictEqual(rest, {
          allowances: [
            {
              limit: 1000,
              name: "Credits",
              overage: {
                cap: 40_000,
                charges: 319.144848378096,
                credits: 7978.62,
                currency: "USD",
                enabled: true,
                rate: 0.04,
              },
              used: 8978.62,
            },
          ],
          plan: "Kiro Pro",
          resetsAt: 1_793_491_200_000,
        });
        assert.notInclude(toJson(usage), "someone@example.com");
        assert.notInclude(toJson(usage), "user-1");
      })
  );

  it.live(
    "usage: a free account shows its active trial, and a limit of 0 is left out",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const { usage } = yield* usageAnswering({
          nextDateReset: 1_793_491_200,
          overageConfiguration: { overageStatus: "DISABLED" },
          subscriptionInfo: { subscriptionTitle: "KIRO FREE" },
          usageBreakdownList: [
            {
              currentUsageWithPrecision: 12.5,
              displayNamePlural: "Credits",
              freeTrialInfo: {
                currentUsageWithPrecision: 120.25,
                freeTrialExpiry: 1_794_000_000,
                freeTrialStatus: "ACTIVE",
                usageLimitWithPrecision: 500,
              },
              usageLimitWithPrecision: 50,
            },
            {
              currentUsage: 0,
              displayNamePlural: "Agentic requests",
              usageLimit: 0,
            },
            {
              displayNamePlural: "Old trial",
              freeTrialInfo: { freeTrialStatus: "EXPIRED", usageLimit: 100 },
              usageLimit: 10,
            },
          ],
        });
        assert.strictEqual(usage.plan, "Kiro Free");
        assert.deepStrictEqual(usage.allowances, [
          {
            limit: 50,
            name: "Credits",
            trial: { expiresAt: 1_794_000_000_000, limit: 500, used: 120.25 },
            used: 12.5,
          },
          { limit: 10, name: "Old trial", used: 0 },
        ]);
      })
  );

  it.live(
    "usage: a reset or expiry read as epoch seconds, epoch ms or an ISO date, and junk as none",
    () =>
      Effect.gen(function* () {
        signIn({ access: "tok" });
        const { usage } = yield* usageAnswering({
          nextDateReset: "2026-11-01T00:00:00Z",
          usageBreakdownList: [
            trial("2026-11-05"),
            trial(1_794_000_000_000),
            trial("not a date"),
            trial(""),
          ],
        });
        assert.strictEqual(usage.resetsAt, 1_793_491_200_000);
        assert.deepStrictEqual(
          Arr.map(usage.allowances, (allowance) => allowance.trial?.expiresAt),
          [1_793_836_800_000, 1_794_000_000_000, undefined, undefined]
        );
        // a top-level reset that doesn't read falls back to the first breakdown's
        const fallback = yield* usageAnswering({
          nextDateReset: "junk",
          usageBreakdownList: [
            {
              displayNamePlural: "Credits",
              nextDateReset: 1_793_491_200,
              usageLimit: 50,
            },
          ],
        });
        assert.strictEqual(fallback.usage.resetsAt, 1_793_491_200_000);
      })
  );

  it.live("usage: an answer Kiro won't give is Kiro's message and status", () =>
    Effect.gen(function* () {
      signIn({ access: "tok" });
      net.answer = () =>
        reply({ message: "Not allowed", reason: null }, { status: 403 });
      const error = yield* run(
        Effect.flip(Effect.flatMap(KiroAccount, (account) => account.usage))
      );
      assertSubset(error, {
        _tag: "KiroApiError",
        message: "Kiro: Not allowed (HTTP 403)",
        status: 403,
      });
    })
  );
});
