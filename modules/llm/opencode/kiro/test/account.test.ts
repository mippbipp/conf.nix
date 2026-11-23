// The Kiro account through src/account.ts's KiroAccount: the sign-in it
// reads, refreshes and writes back, and what it asks Kiro's management API.
// Run with BUN_BE_BUN=1 opencode test. HOME is a throwaway dir and PATH is
// empty (see signin.ts); HTTP goes to the fake client below.

import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  Array as Arr,
  Effect,
  Fiber,
  Layer,
  Option,
  type Schema,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/http";
import { TestClock } from "effect/testing";

import { KiroAccount } from "../src/account.ts";
import { PROFILE, throwawayHome } from "./signin.ts";

const {
  dbPath,
  ideToken,
  kiroCli,
  signIn,
  signInIDE,
  signOut,
  stored,
  storedIDE,
} = throwawayHome();

// the fake network: each test sets how it answers
type Answer = (
  request: HttpClientRequest.HttpClientRequest
) => Promise<Response>;
const offline: Answer = async () => {
  throw new Error("no network in tests");
};
let answer = offline;
const http = HttpClient.make((request) =>
  Effect.tryPromise({
    catch: (cause) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ cause, request }),
      }),
    try: async () => HttpClientResponse.fromWeb(request, await answer(request)),
  })
);
const layer = KiroAccount.layer.pipe(
  Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
);
const run = <A, E>(effect: Effect.Effect<A, E, KiroAccount>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer))).finally(() => {
    answer = offline;
  });
const textOf = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? new TextDecoder().decode(request.body.body)
    : "";
const path = (request: HttpClientRequest.HttpClientRequest) =>
  new URL(request.url).pathname;
const param = (request: HttpClientRequest.HttpClientRequest, name: string) =>
  Option.getOrUndefined(UrlParams.getFirst(request.urlParams, name));

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
const SOON = () => Date.now() + 30_000;

// ---- sign-in and refresh -----------------------------------------------------------

test("reads kiro-cli's sign-in, with the profile kiro-cli keeps apart from the token", async () => {
  signIn();
  expect(await credentials()).toEqual({
    profile: PROFILE,
    region: "us-east-1",
    token: "old",
    tokenType: "",
  });
});

test("a token near its end is refreshed at AWS and written back for kiro-cli", async () => {
  signIn({ expires: SOON() });
  const seen: Array<[string, unknown]> = [];
  answer = async (request) => {
    seen.push([request.url, JSON.parse(textOf(request))]);
    return Response.json({
      accessToken: "new",
      expiresIn: 3600,
      refreshToken: "r2",
    });
  };
  expect(await credentials()).toMatchObject({
    profile: PROFILE,
    region: "us-east-1",
    token: "new",
  });
  expect(seen).toEqual([
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
  expect(stored()).toMatchObject({
    access_token: "new",
    refresh_token: "r2",
    scopes: ["codewhisperer:conversations"],
  });
});

test("a Google or GitHub sign-in is refreshed the way the Kiro IDE does, and keeps the profile Kiro gives", async () => {
  kiroCli([
    {
      key: "kirocli:social:token",
      value: {
        access_token: "old",
        expires_at: new Date(SOON()).toISOString(),
        provider: "Google",
        refresh_token: "r1",
        region: "us-east-1",
      },
    },
  ]);
  const seen: Array<{ body: unknown; ua: string | undefined; url: string }> =
    [];
  answer = async (request) => {
    seen.push({
      body: JSON.parse(textOf(request)),
      ua: request.headers["user-agent"],
      url: request.url,
    });
    return Response.json({
      accessToken: "new",
      expiresIn: 3600,
      profileArn: "arn:aws:codewhisperer:us-east-1:333333333333:profile/SOCIAL",
      refreshToken: "r2",
    });
  };
  expect(await credentials()).toEqual({
    profile: "arn:aws:codewhisperer:us-east-1:333333333333:profile/SOCIAL",
    region: "us-east-1",
    token: "new",
    tokenType: "",
  });
  expect(seen).toEqual([
    {
      body: { refreshToken: "r1" },
      ua: "Kiro-Desktop/0.2.13 (darwin; arm64)",
      url: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
    },
  ]);
  expect(stored("kirocli:social:token")).toMatchObject({
    access_token: "new",
    profile_arn: "arn:aws:codewhisperer:us-east-1:333333333333:profile/SOCIAL",
    provider: "Google",
    refresh_token: "r2",
  });
});

test("a company's own identity provider is refreshed at its token endpoint, and its calls say so", async () => {
  const profile = "arn:aws:codewhisperer:us-east-1:444444444444:profile/IDP";
  kiroCli([
    {
      key: "kirocli:external-idp:token",
      value: {
        access_token: "old",
        client_id: "idp-client",
        expires_at: new Date(SOON()).toISOString(),
        issuer_url: "https://login.example.com/oauth2/",
        profile_arn: profile,
        refresh_token: "r1",
        region: "us-east-1",
      },
    },
  ]);
  const seen: Array<{ body: string; type: string | undefined; url: string }> =
    [];
  answer = async (request) => {
    const query = UrlParams.toString(request.urlParams);
    seen.push({
      body: textOf(request),
      type: request.headers.tokentype,
      url: request.url + (query ? `?${query}` : ""),
    });
    if (path(request) === "/Get-Usage-Limits") {
      return Response.json({});
    }
    return Response.json({
      access_token: "new",
      expires_in: 3600,
      refresh_token: "r2",
    });
  };
  await run(Effect.flatMap(KiroAccount, (account) => account.usage));
  expect(seen).toEqual([
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
  expect(stored("kirocli:external-idp:token")).toMatchObject({
    access_token: "new",
    client_id: "idp-client",
    refresh_token: "r2",
  });
});

test("the Kiro IDE's sign-in is refreshed with its client and written back to its file", async () => {
  signOut();
  signInIDE(
    {
      accessToken: "old",
      authMethod: "IdC",
      clientIdHash: "h",
      expiresAt: new Date(SOON()).toISOString(),
      profileArn: PROFILE,
      provider: "Enterprise",
      refreshToken: "r1",
      region: "us-east-1",
    },
    { clientId: "c", clientSecret: "s" }
  );
  const seen: Array<unknown> = [];
  answer = async (request) => {
    seen.push(JSON.parse(textOf(request)));
    return Response.json({
      accessToken: "new",
      expiresIn: 3600,
      refreshToken: "r2",
    });
  };
  expect(await credentials()).toMatchObject({ profile: PROFILE, token: "new" });
  expect(seen).toEqual([
    {
      clientId: "c",
      clientSecret: "s",
      grantType: "refresh_token",
      refreshToken: "r1",
    },
  ]);
  expect(storedIDE()).toMatchObject({
    accessToken: "new",
    clientIdHash: "h",
    provider: "Enterprise",
    refreshToken: "r2",
  });
  expect(existsSync(`${ideToken}.opencode-tmp`)).toBe(false);
  signOut();
});

// twice is the credentials two calls on one account get
const twice = () =>
  run(
    Effect.gen(function* () {
      const account = yield* KiroAccount;
      return [yield* account.credentials(), yield* account.credentials()];
    })
  );

test("a sign-in kiro-cli took while a refresh was out is kept, and used next", async () => {
  signIn({ expires: SOON() });
  answer = async () => {
    // the user signs in again before AWS answers the plugin's refresh
    signIn({ access: "other", refresh: "r-other" });
    return Response.json({
      accessToken: "new",
      expiresIn: 3600,
      refreshToken: "r2",
    });
  };
  const [first, next] = await twice();
  expect(first).toMatchObject({ token: "new" });
  expect(stored()).toMatchObject({
    access_token: "other",
    refresh_token: "r-other",
  });
  expect(next).toMatchObject({ token: "other" });
});

test("a sign-in the Kiro IDE took while a refresh was out is kept, and used next", async () => {
  signOut();
  const ide = (accessToken: string, refreshToken: string, expires: number) => ({
    accessToken,
    authMethod: "IdC",
    clientIdHash: "h",
    expiresAt: new Date(expires).toISOString(),
    profileArn: PROFILE,
    provider: "Enterprise",
    refreshToken,
    region: "us-east-1",
  });
  signInIDE(ide("old", "r1", SOON()), { clientId: "c", clientSecret: "s" });
  answer = async () => {
    signInIDE(ide("other", "r-other", Date.now() + 60 * 60_000));
    return Response.json({
      accessToken: "new",
      expiresIn: 3600,
      refreshToken: "r2",
    });
  };
  const [first, next] = await twice();
  expect(first).toMatchObject({ token: "new" });
  expect(storedIDE()).toMatchObject({
    accessToken: "other",
    refreshToken: "r-other",
  });
  expect(existsSync(`${ideToken}.opencode-tmp`)).toBe(false);
  expect(next).toMatchObject({ token: "other" });
  signOut();
});

test("one refresh at a time: two requests at once spend the refresh token once", async () => {
  signIn({ expires: Date.now() - 1000 });
  const refreshes: Array<unknown> = [];
  answer = async (request) => {
    refreshes.push(JSON.parse(textOf(request)));
    await Bun.sleep(30);
    return Response.json({
      accessToken: "new",
      expiresIn: 3600,
      refreshToken: "r2",
    });
  };
  const both = await run(
    Effect.gen(function* () {
      const account = yield* KiroAccount;
      return yield* Effect.all([account.credentials(), account.credentials()], {
        concurrency: 2,
      });
    })
  );
  expect(Arr.map(both, (auth) => auth.token)).toEqual(["new", "new"]);
  expect(refreshes).toHaveLength(1);
});

test("a refresh whose write-back failed isn't repeated with the refresh token it spent", async () => {
  signIn({ expires: Date.now() - 1000 });
  const refreshes: Array<unknown> = [];
  answer = async (request) => {
    refreshes.push(JSON.parse(textOf(request)));
    return Response.json({
      accessToken: "new",
      expiresIn: 3600,
      refreshToken: "r2",
    });
  };
  // a database the plugin may read but not write: the write-back can't land
  chmodSync(dbPath, 0o444);
  try {
    const tokens = await run(
      Effect.gen(function* () {
        const account = yield* KiroAccount;
        const first = yield* account.credentials();
        const second = yield* account.credentials();
        return [first.token, second.token];
      })
    );
    expect(tokens).toEqual(["new", "new"]);
    expect(refreshes).toHaveLength(1);
  } finally {
    chmodSync(dbPath, 0o644);
  }
  expect(stored().access_token).toBe("old");
});

test("a refresh that fails says why: a refused one asks for a sign-in, another is retried", async () => {
  signIn({ expires: Date.now() - 1000 });
  for (const status of [400, 401, 403]) {
    answer = async () => Response.json({ error: "invalid_grant" }, { status });
    expect(await credentialsError()).toMatchObject({
      _tag: "SignInError",
      message:
        "Kiro's sign-in has expired. Run `kiro-cli login`, then try again.",
    });
  }
  answer = async () => new Response("", { status: 503 });
  expect(await credentialsError()).toMatchObject({
    _tag: "RefreshError",
    message:
      "Couldn't refresh Kiro's sign-in: oidc.us-east-1.amazonaws.com answered HTTP 503",
  });
  answer = offline;
  const unreachable = await credentialsError();
  expect(unreachable._tag).toBe("RefreshError");
  expect(unreachable.message).toStartWith("Couldn't refresh Kiro's sign-in: ");
  // with no refresh token there is nothing to ask AWS with
  signIn({ expires: Date.now() - 1000, refresh: "" });
  answer = async () => {
    throw new Error("AWS was asked");
  };
  expect(await credentialsError()).toMatchObject({ _tag: "SignInError" });
});

// ---- deadlines -------------------------------------------------------------------

// stalled is an answer whose headers arrive and whose body never ends
const stalled = async () =>
  new Response(new ReadableStream(), {
    headers: { "content-type": "application/json" },
  });
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

test("a token endpoint that stalls in its body fails the refresh after 30 seconds, and blocks nothing after", async () => {
  signIn();
  answer = stalled;
  const out = await run(
    Effect.gen(function* () {
      const account = yield* KiroAccount;
      const failed = yield* failsAfter(30, account.credentials("old"));
      return { ...failed, next: yield* account.credentials() };
    }).pipe(Effect.provide(TestClock.layer()))
  );
  expect(out.early).toBeUndefined();
  expect(out.error).toMatchObject({
    _tag: "RefreshError",
    message:
      "Couldn't refresh Kiro's sign-in: oidc.us-east-1.amazonaws.com didn't answer within 30 seconds",
  });
  expect(out.next).toMatchObject({ token: "old" });
});

test("a management call that stalls in its body fails after 20 seconds as Kiro's 502", async () => {
  signIn({ access: "tok" });
  answer = stalled;
  const out = await run(
    Effect.flatMap(KiroAccount, (account) =>
      failsAfter(20, account.usage)
    ).pipe(Effect.provide(TestClock.layer()))
  );
  expect(out.early).toBeUndefined();
  expect(out.error).toMatchObject({
    _tag: "KiroApiError",
    message:
      "Couldn't reach Kiro for Get-Usage-Limits: management.us-east-1.kiro.dev didn't answer within 20 seconds",
    status: 502,
  });
});

// ---- the profile and region --------------------------------------------------------

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
  // SAFETY: the cast types an empty array
  const seen = { listedWith: [] as Array<string | undefined>, profiles: 0 };
  answer = async (request) => {
    if (path(request) === "/List-Available-Profiles") {
      seen.profiles++;
      if (profiles) {
        return Response.json({ profiles });
      }
      const message = "AWS Builder ID is not supported for this operation";
      return Response.json({ message, reason: null }, { status: 403 });
    }
    if (path(request) === "/List-Available-Models") {
      const profile = param(request, "profileArn");
      seen.listedWith.push(profile);
      if (profile === BUILDER_ID || profile === IDC) {
        return Response.json({ models: STUDENT });
      }
      return Response.json(
        { message: "profileArn is required" },
        { status: 400 }
      );
    }
    throw new Error(`unexpected request to ${request.url}`);
  };
  return seen;
}

test("kiro-cli's Builder ID sign-in (its start URL, or none) is asked with Builder ID's profile", async () => {
  for (const start of ["https://view.awsapps.com/start", null]) {
    signIn({ profile: null, start });
    const seen = management();
    expect(await credentials()).toMatchObject({
      profile: BUILDER_ID,
      region: "us-east-1",
    });
    expect(seen.profiles).toBe(0);
  }
});

test("a Builder ID account's own models are listed under Builder ID's profile", async () => {
  signIn({ profile: null, start: null });
  const seen = management();
  const models = await run(
    Effect.flatMap(KiroAccount, (account) => account.models)
  );
  expect(seen.listedWith).toEqual([BUILDER_ID]);
  expect(Arr.map(models, (model) => [model.id, model.name])).toEqual([
    ["auto", "Auto"],
    ["claude-opus-5.5", "claude-opus-5.5"],
  ]);
});

test("an Identity Center sign-in with no profile has its own listed, once", async () => {
  signIn({ profile: null });
  const seen = management([{ arn: IDC }]);
  const both = await run(
    Effect.gen(function* () {
      const account = yield* KiroAccount;
      return [yield* account.credentials(), yield* account.credentials()];
    })
  );
  expect(Arr.map(both, (auth) => auth.profile)).toEqual([IDC, IDC]);
  expect(seen.profiles).toBe(1);
});

test("an account signed into in place of another has its own profile listed", async () => {
  const OTHER = "arn:aws:codewhisperer:us-east-1:666666666666:profile/OTHER";
  signIn({ profile: null });
  const asked: Array<string | undefined> = [];
  answer = async (request) => {
    const token = request.headers.authorization;
    asked.push(token);
    return Response.json({
      profiles: [{ arn: token === "Bearer b" ? OTHER : IDC }],
    });
  };
  const both = await run(
    Effect.gen(function* () {
      const account = yield* KiroAccount;
      const first = yield* account.credentials();
      yield* Effect.sync(() =>
        signIn({ access: "b", profile: null, refresh: "rb" })
      );
      return [first, yield* account.credentials()];
    })
  );
  expect(Arr.map(both, (auth) => [auth.token, auth.profile])).toEqual([
    ["old", IDC],
    ["b", OTHER],
  ]);
  expect(asked).toEqual(["Bearer old", "Bearer b"]);
});

test("a profile listed for a sign-in is kept when a refresh replaces its refresh token", async () => {
  signIn({ expires: SOON(), profile: null });
  let listed = 0;
  let refreshes = 0;
  answer = async (request) => {
    if (path(request) === "/List-Available-Profiles") {
      listed++;
      return Response.json({ profiles: [{ arn: IDC }] });
    }
    refreshes++;
    return Response.json({
      accessToken: `new${refreshes}`,
      expiresIn: 3600,
      refreshToken: `r${refreshes + 1}`,
    });
  };
  const both = await run(
    Effect.gen(function* () {
      const account = yield* KiroAccount;
      return [yield* account.credentials(), yield* account.credentials("new1")];
    })
  );
  expect(Arr.map(both, (auth) => [auth.token, auth.profile])).toEqual([
    ["new1", IDC],
    ["new2", IDC],
  ]);
  expect(listed).toBe(1);
});

// withFakeKiroCli puts a kiro-cli in the throwaway HOME's ~/.local/bin, where
// the plugin looks with PATH empty, for the length of use. Its
// `debug refresh-auth-token` writes token as kiro-cli's sign-in.
async function withFakeKiroCli<A>(
  token: Schema.JsonObject,
  use: () => Promise<A>
) {
  const bin = join(process.env.HOME!, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "refresh.ts");
  writeFileSync(
    script,
    `import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)});
db.query("INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)")
  .run("kirocli:odic:token", ${JSON.stringify(JSON.stringify(token))});
db.close();
`
  );
  const kiroCliPath = join(bin, "kiro-cli");
  writeFileSync(
    kiroCliPath,
    `#!/bin/sh\nBUN_BE_BUN=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`,
    { mode: 0o755 }
  );
  try {
    return await use();
  } finally {
    rmSync(bin, { force: true, recursive: true });
  }
}
const cliToken = (access: string, refresh: string) => ({
  access_token: access,
  expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  refresh_token: refresh,
  region: "us-east-1",
  start_url: "https://example.awsapps.com/start",
});
// an expiry long past
const RAN_OUT = Date.parse("2026-01-01T00:00:00Z");

test("a sign-in kiro-cli swaps in while it refreshes has its own profile listed", async () => {
  const OTHER = "arn:aws:codewhisperer:us-east-1:666666666666:profile/OTHER";
  signIn({ profile: null });
  const asked: Array<string | undefined> = [];
  answer = async (request) => {
    const token = request.headers.authorization;
    asked.push(token);
    return Response.json({
      profiles: [{ arn: token === "Bearer b" ? OTHER : IDC }],
    });
  };
  const both = await withFakeKiroCli(cliToken("b", "rb"), () =>
    run(
      Effect.gen(function* () {
        const account = yield* KiroAccount;
        const first = yield* account.credentials();
        // the same sign-in, run out
        yield* Effect.sync(() => signIn({ expires: RAN_OUT, profile: null }));
        return [first, yield* account.credentials()];
      })
    )
  );
  expect(Arr.map(both, (auth) => [auth.token, auth.profile])).toEqual([
    ["old", IDC],
    ["b", OTHER],
  ]);
  expect(asked).toEqual(["Bearer old", "Bearer b"]);
});

test("a sign-in kiro-cli refreshes keeps the profile listed for it", async () => {
  signIn({ profile: null });
  const asked: Array<string | undefined> = [];
  answer = async (request) => {
    asked.push(request.headers.authorization);
    return Response.json({ profiles: [{ arn: IDC }] });
  };
  const both = await withFakeKiroCli(cliToken("a2", "r1"), () =>
    run(
      Effect.gen(function* () {
        const account = yield* KiroAccount;
        const first = yield* account.credentials();
        yield* Effect.sync(() => signIn({ expires: RAN_OUT, profile: null }));
        return [first, yield* account.credentials()];
      })
    )
  );
  expect(Arr.map(both, (auth) => [auth.token, auth.profile])).toEqual([
    ["old", IDC],
    ["a2", IDC],
  ]);
  expect(asked).toEqual(["Bearer old"]);
});

test("an AWS sign-in whose profiles Kiro won't list for Builder ID takes Builder ID's profile", async () => {
  signIn({ profile: null });
  const seen = management();
  expect(await credentials()).toMatchObject({ profile: BUILDER_ID });
  expect(seen.profiles).toBe(1);
});

test("the Kiro IDE's Builder ID sign-in is asked with Builder ID's profile", async () => {
  signOut();
  signInIDE(
    {
      accessToken: "ide",
      authMethod: "IdC",
      clientIdHash: "h",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      provider: "BuilderId",
      refreshToken: "r",
      region: "us-east-1",
    },
    { clientId: "c", clientSecret: "s" }
  );
  const seen = management();
  expect(await credentials()).toMatchObject({
    profile: BUILDER_ID,
    token: "ide",
  });
  expect(seen.profiles).toBe(0);
  signOut();
});

test("an account's API is in its profile's region, else the one of Kiro's nearer its sign-in", async () => {
  const EU = "arn:aws:codewhisperer:eu-central-1:555555555555:profile/EU";
  // an Identity Center sign-in in Europe, its profile listed in eu-central-1
  signIn({ profile: null, region: "eu-west-1" });
  const asked: Array<string> = [];
  answer = async (request) => {
    const url = new URL(request.url);
    asked.push(url.host + url.pathname);
    if (url.pathname === "/Get-Usage-Limits") {
      return Response.json({});
    }
    if (url.host === "management.eu-central-1.kiro.dev") {
      return Response.json({ profiles: [{ arn: EU }] });
    }
    return Response.json({ profiles: [] });
  };
  const listed = await run(
    Effect.gen(function* () {
      const account = yield* KiroAccount;
      const auth = yield* account.credentials();
      yield* account.usage;
      return auth;
    })
  );
  expect(listed).toMatchObject({ profile: EU, region: "eu-central-1" });
  expect(asked).toEqual([
    "management.us-east-1.kiro.dev/List-Available-Profiles",
    "management.eu-central-1.kiro.dev/List-Available-Profiles",
    "management.eu-central-1.kiro.dev/Get-Usage-Limits",
  ]);
  // a profile that names no region: Kiro's region nearer the sign-in
  signIn({ profile: "EU", region: "eu-west-1" });
  expect(await credentials()).toMatchObject({
    profile: "EU",
    region: "eu-central-1",
  });
  signIn({ profile: "AP", region: "ap-south-1" });
  expect(await credentials()).toMatchObject({
    profile: "AP",
    region: "us-east-1",
  });
});

test("with no sign-in, there are no credentials and nothing is asked", async () => {
  signOut();
  expect(await credentialsError()).toMatchObject({
    _tag: "SignInError",
    message: "Kiro isn't signed in. Run `kiro-cli login`, then try again.",
  });
});

// ---- the management API ------------------------------------------------------------

test("models: every page is listed, the default first, and one in a shape not known is left out", async () => {
  signIn({ access: "tok" });
  const asked: Array<string | undefined> = [];
  answer = async (request) => {
    asked.push(param(request, "nextToken"));
    if (!param(request, "nextToken")) {
      return Response.json({
        defaultModel: { modelId: "claude-b" },
        models: [
          { modelId: "claude-a", modelName: "Claude A" },
          { modelName: "no id" },
        ],
        nextToken: "p2",
      });
    }
    return Response.json({
      models: [{ modelId: "claude-b", modelName: "Claude B" }],
    });
  };
  const models = await run(
    Effect.flatMap(KiroAccount, (account) => account.models)
  );
  expect(asked).toEqual([undefined, "p2"]);
  expect(Arr.map(models, (model) => model.id)).toEqual([
    "claude-b",
    "claude-a",
  ]);
});

test("models: a listing with none in it is Kiro's failure", async () => {
  signIn({ access: "tok" });
  answer = async () => Response.json({ models: [] });
  const error = await run(
    Effect.flip(Effect.flatMap(KiroAccount, (account) => account.models))
  );
  expect(error).toMatchObject({
    _tag: "KiroApiError",
    message: "Kiro listed no models",
    status: 502,
  });
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
async function usageAnswering(limits: Schema.JsonObject) {
  const asked: Array<Record<string, string>> = [];
  answer = async (request) => {
    if (path(request) !== "/Get-Usage-Limits") {
      throw new Error(`unexpected ${request.url}`);
    }
    // SAFETY: the plugin sets each query parameter once, so none is an array
    asked.push(UrlParams.toRecord(request.urlParams) as Record<string, string>);
    return Response.json(limits);
  };
  const usage = await run(
    Effect.flatMap(KiroAccount, (account) => account.usage)
  );
  return { asked, usage };
}

test("usage: Get-Usage-Limits reads as the plan, its credits and the overage, and nothing of the user", async () => {
  signIn({ access: "tok" });
  const { asked, usage } = await usageAnswering(PRO_USAGE);
  expect(asked).toEqual([
    { origin: "KIRO_CLI", profileArn: PROFILE, resourceType: "CREDIT" },
  ]);
  expect(usage).toEqual({
    allowances: [
      {
        limit: 1000,
        name: "Credits",
        overage: {
          credits: 7978.62,
          charges: 319.144848378096,
          currency: "USD",
          rate: 0.04,
          cap: 40_000,
          enabled: true,
        },
        used: 8978.62,
      },
    ],
    checkedAt: expect.any(Number),
    plan: "Kiro Pro",
    resetsAt: 1_793_491_200_000,
  });
  expect(JSON.stringify(usage)).not.toContain("someone@example.com");
  expect(JSON.stringify(usage)).not.toContain("user-1");
});

test("usage: a free account shows its active trial, and a limit of 0 is left out", async () => {
  signIn({ access: "tok" });
  const { usage } = await usageAnswering({
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
      { currentUsage: 0, displayNamePlural: "Agentic requests", usageLimit: 0 },
      {
        displayNamePlural: "Old trial",
        freeTrialInfo: { freeTrialStatus: "EXPIRED", usageLimit: 100 },
        usageLimit: 10,
      },
    ],
  });
  expect(usage.plan).toBe("Kiro Free");
  expect(usage.allowances).toEqual([
    {
      limit: 50,
      name: "Credits",
      trial: { expiresAt: 1_794_000_000_000, limit: 500, used: 120.25 },
      used: 12.5,
    },
    { limit: 10, name: "Old trial", used: 0 },
  ]);
});

test("usage: a reset or expiry read as epoch seconds, epoch ms or an ISO date, and junk as none", async () => {
  signIn({ access: "tok" });
  const trial = (freeTrialExpiry: string | number) => ({
    displayNamePlural: "Credits",
    freeTrialInfo: {
      freeTrialExpiry,
      freeTrialStatus: "ACTIVE",
      usageLimit: 500,
    },
    usageLimitWithPrecision: 50,
  });
  const { usage } = await usageAnswering({
    nextDateReset: "2026-11-01T00:00:00Z",
    usageBreakdownList: [
      trial("2026-11-05"),
      trial(1_794_000_000_000),
      trial("not a date"),
      trial(""),
    ],
  });
  expect(usage.resetsAt).toBe(1_793_491_200_000);
  expect(
    Arr.map(usage.allowances, (allowance) => allowance.trial?.expiresAt)
  ).toEqual([1_793_836_800_000, 1_794_000_000_000, undefined, undefined]);
  // a top-level reset that doesn't read falls back to the first breakdown's
  const fallback = await usageAnswering({
    nextDateReset: "junk",
    usageBreakdownList: [
      {
        displayNamePlural: "Credits",
        nextDateReset: 1_793_491_200,
        usageLimit: 50,
      },
    ],
  });
  expect(fallback.usage.resetsAt).toBe(1_793_491_200_000);
});

test("usage: an answer Kiro won't give is Kiro's message and status", async () => {
  signIn({ access: "tok" });
  answer = async () =>
    Response.json({ message: "Not allowed", reason: null }, { status: 403 });
  const error = await run(
    Effect.flip(Effect.flatMap(KiroAccount, (account) => account.usage))
  );
  expect(error).toMatchObject({
    _tag: "KiroApiError",
    message: "Kiro: Not allowed (HTTP 403)",
    status: 403,
  });
});
