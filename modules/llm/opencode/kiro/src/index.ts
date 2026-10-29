// Kiro as an OpenCode 2 provider, on kiro-cli's auth.
//
// OpenCode stores nothing for it. Each request reads the token kiro-cli
// keeps in its SQLite database (the Kiro IDE's when kiro-cli isn't signed
// in), has kiro-cli refresh it when it is about to run out, and writes back
// a token refreshed here so kiro-cli carries on with it.
//
// Kiro has no API OpenCode speaks. The provider sits on OpenCode's native
// Anthropic Messages route, and two session hooks do the translating.
// http.request turns each Messages request into a call to Kiro's
// generateAssistantResponse (the API kiro-cli uses), and http.response
// turns the AWS event stream Kiro answers with back into Messages events.
//
// OpenCode loads this file as it is: Bun strips the types, and OpenCode
// supplies `effect` and `@opencode/plugin` itself, so the plugin may import
// only those, Bun's and Node's own modules, and the files beside it. The
// no-restricted-imports rule in ../oxlint.config.ts fails lint on any other.
//
// The sidebar (tui.tsx) shows the account's usage and what each session has
// spent, which it asks for over the RPC in rpc.ts.

import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { Model, Plugin, Provider } from "@opencode/plugin/effect";
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Sink,
  Stream,
  Tracer,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as Failure from "./failure.ts";
import { type AccountUsage, type Allowance, KiroRpc, type UsageAnswer } from "./rpc.ts";

const ID = "kiro";
const PACKAGE = "@opencode/ai/providers/anthropic";
// where the Anthropic route posts; http.request sends it on to the account's region
const BASE = "https://runtime.us-east-1.kiro.dev";
const MODELS_KEY = "models";

const oidc = (region: string) => `https://oidc.${region}.amazonaws.com`;
const runtime = (region: string) => `https://runtime.${region}.kiro.dev`;
const management = (region: string) => `https://management.${region}.kiro.dev`;
const refreshURL = (region: string) => `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
// how the Kiro IDE names itself when it refreshes a Google or GitHub sign-in
const DESKTOP_UA = "Kiro-Desktop/0.2.13 (darwin; arm64)";
// A Builder ID sign-in has no profile of its own and Kiro won't list one for
// it (List-Available-Profiles answers 403, "AWS Builder ID is not supported
// for this operation"). kiro-cli and the IDE use this service profile.
const BUILDER_ID_START = "https://view.awsapps.com/start";
const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
const isBuilderID = (provider: string | null | undefined) =>
  (provider ?? "").toLowerCase() === "builderid";

const env = (k: string) => process.env[k] ?? "";
const home = () => env("HOME") || homedir();

const codeOf = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e ? e.code : undefined;

// Kiro's reply is dropped after this long with nothing from Kiro, the
// default of kiro-cli's own watchdog (api.streamIdleHardTimeout). A 504
// that OpenCode retries.
const IDLE_SECONDS = 300;
// how long Kiro may take to answer a request this plugin sends itself
// (the one resent with a refreshed token) before it starts the reply
const HEADERS_SECONDS = 60;

// ---- where kiro-cli and the Kiro IDE keep their sign-in -------------------------

type Method = "social" | "idc" | "external-idp";

// Cred is a sign-in as read from kiro-cli or the IDE.
interface Cred {
  access: string;
  refresh: string;
  expires: number; // epoch ms, 0 when unknown
  region: string;
  profile: string;
  method: Method;
  dbKey?: string; // kiro-cli's auth_kv key
  idePath?: string; // the IDE's token file
  builderID?: boolean;
  clientId?: string;
  clientSecret?: string;
  tokenURL?: string;
}

// a field kiro-cli or the IDE may leave out, or write as null
const field = <S extends Schema.Constraint>(s: S) => Schema.optional(Schema.NullOr(s));

// what kiro-cli keeps under kirocli:<kind>:token
const CliToken = Schema.Struct({
  access_token: field(Schema.String),
  refresh_token: field(Schema.String),
  expires_at: field(Schema.String),
  region: field(Schema.String),
  profile_arn: field(Schema.String),
  start_url: field(Schema.String),
  client_id: field(Schema.String),
  token_endpoint: field(Schema.String),
  issuer_url: field(Schema.String),
});
const CliRegistration = Schema.Struct({
  client_id: field(Schema.String),
  client_secret: field(Schema.String),
});
const CliProfile = Schema.Struct({ arn: field(Schema.String) });

// what the IDE keeps in ~/.aws/sso/cache/kiro-auth-token.json
const IdeToken = Schema.Struct({
  accessToken: field(Schema.String),
  refreshToken: field(Schema.String),
  expiresAt: field(Schema.String),
  region: field(Schema.String),
  profileArn: field(Schema.String),
  provider: field(Schema.String),
  authMethod: field(Schema.String),
  clientIdHash: field(Schema.String),
});
const IdeRegistration = Schema.Struct({
  clientId: field(Schema.String),
  clientSecret: field(Schema.String),
});

// a JSON object as it is, for writing a token back with every field it had
const JsonObject = Schema.Record(Schema.String, Schema.Json);

const decodeCliToken = Schema.decodeUnknownOption(Schema.fromJsonString(CliToken));
const decodeCliRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(CliRegistration));
const decodeCliProfile = Schema.decodeUnknownOption(Schema.fromJsonString(CliProfile));
const decodeIdeToken = Schema.decodeUnknownOption(Schema.fromJsonString(IdeToken));
const decodeIdeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(IdeRegistration));
const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));

const parsed = <A>(decode: (u: unknown) => Option.Option<A>, text: string | undefined) =>
  text === undefined ? undefined : Option.getOrUndefined(decode(text));

function cliDB() {
  if (process.platform === "win32")
    return join(env("APPDATA") || join(home(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3");
  if (process.platform === "darwin")
    return join(home(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  return join(home(), ".local", "share", "kiro-cli", "data.sqlite3");
}
const ideDir = () => join(home(), ".aws", "sso", "cache");

// kiroExecutable finds kiro-cli, which refreshes its own sign-in.
function kiroExecutable() {
  for (const d of env("PATH").split(delimiter)) {
    const p = join(d, process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli");
    if (d && isFile(p)) return p;
  }
  for (const p of [
    join(home(), ".local", "bin", "kiro-cli"),
    "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli",
    "/usr/local/bin/kiro-cli",
    "/opt/homebrew/bin/kiro-cli",
  ])
    if (isFile(p)) return p;
  return "";
}
function isFile(p: string) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const time = (s: string | null | undefined) =>
  s ? Option.match(DateTime.make(s), { onNone: () => 0, onSome: DateTime.toEpochMillis }) : 0;

// withDB opens kiro-cli's database for use, and closes it after.
const withDB = <A>(
  path: string,
  options: { readonly: true } | { readwrite: true },
  use: (db: Database) => A
) =>
  Effect.acquireUseRelease(
    Effect.try(() => new Database(path, options)),
    (db) => Effect.try(() => use(db)),
    (db) => Effect.sync(() => db.close())
  );

type Row = { value: string | Uint8Array | null };

// readText is a value kiro-cli keeps; the state table's values are declared
// BLOB, though kiro-cli writes text.
function readText(db: Database, table: "auth_kv" | "state", key: string) {
  const raw = db.query<Row, [string]>(`SELECT value FROM ${table} WHERE key = ?`).get(key)?.value;
  const value = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
  return value || undefined;
}

const CLI_KINDS = ["social", "odic", "external-idp"] as const;
type CliRows = {
  tokens: { kind: (typeof CLI_KINDS)[number]; key: string; text: string | undefined }[];
  registration: string | undefined;
  profile: string | undefined;
};

// cliCred is kiro-cli's sign-in from the rows it keeps: Google or GitHub,
// AWS (Builder ID, IAM Identity Center), or a company's own identity provider.
function cliCred(rows: CliRows): Cred | null {
  for (const { kind, key, text } of rows.tokens) {
    const m = parsed(decodeCliToken, text);
    if (!m?.access_token) continue;
    const c: Cred = {
      access: m.access_token,
      refresh: m.refresh_token ?? "",
      expires: time(m.expires_at),
      region: m.region || "us-east-1",
      // an AWS sign-in's token names no profile; kiro-cli keeps the one it picked in its state
      profile: m.profile_arn || parsed(decodeCliProfile, rows.profile)?.arn || "",
      method: "social",
      dbKey: key,
    };
    if (kind === "odic") {
      c.method = "idc";
      // kiro-cli tells Builder ID apart by its start URL, or by having none
      c.builderID = !m.start_url || m.start_url === BUILDER_ID_START;
      const reg = parsed(decodeCliRegistration, rows.registration);
      if (reg) [c.clientId, c.clientSecret] = [reg.client_id ?? "", reg.client_secret ?? ""];
    } else if (kind === "external-idp") {
      c.method = "external-idp";
      c.clientId = m.client_id ?? "";
      c.tokenURL =
        m.token_endpoint || (m.issuer_url ? m.issuer_url.replace(/\/$/, "") + "/v1/token" : "");
    }
    return c;
  }
  return null;
}

// readCLI reads kiro-cli's sign-in; null when there is none it can read.
const readCLI = Effect.fnUntraced(
  function* () {
    const path = cliDB();
    if (!(yield* Effect.sync(() => existsSync(path)))) return null;
    const rows = yield* withDB(path, { readonly: true }, (db) => ({
      tokens: CLI_KINDS.map((kind) => {
        const key = `kirocli:${kind}:token`;
        return { kind, key, text: readText(db, "auth_kv", key) };
      }),
      registration: readText(db, "auth_kv", "kirocli:odic:device-registration"),
      profile: readText(db, "state", "api.codewhisperer.profile"),
    }));
    return cliCred(rows);
  },
  Effect.orElseSucceed(() => null)
);

const readJson = <A>(path: string, decode: (u: unknown) => Option.Option<A>) =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap((text) => Effect.fromOption(decode(text)))
  );

// readIDE reads the Kiro IDE's sign-in; null when there is none it can read.
const readIDE = Effect.fnUntraced(
  function* () {
    const path = join(ideDir(), "kiro-auth-token.json");
    const t = yield* readJson(path, decodeIdeToken);
    if (!t.accessToken) return null;
    const c: Cred = {
      access: t.accessToken,
      refresh: t.refreshToken ?? "",
      expires: time(t.expiresAt),
      region: t.region || "us-east-1",
      profile: t.profileArn ?? "",
      method: "idc",
      idePath: path,
      builderID: isBuilderID(t.provider),
    };
    if (t.clientIdHash) {
      const reg = yield* readJson(
        join(ideDir(), t.clientIdHash + ".json"),
        decodeIdeRegistration
      ).pipe(Effect.option);
      if (Option.isSome(reg))
        [c.clientId, c.clientSecret] = [reg.value.clientId ?? "", reg.value.clientSecret ?? ""];
    }
    if (String(t.authMethod).toLowerCase() === "social" || !c.clientId) c.method = "social";
    return c;
  },
  Effect.orElseSucceed(() => null)
);

// saveBack writes a refreshed token back where it was read from, so kiro-cli
// or the IDE carries on with it (a refresh may replace the refresh token).
// A save that fails is let go: the token still works until it runs out.
const saveBack = Effect.fnUntraced(
  function* (c: Cred) {
    const expires = DateTime.formatIso(DateTime.makeUnsafe(c.expires));
    if (c.dbKey) {
      const key = c.dbKey;
      yield* withDB(cliDB(), { readwrite: true }, (db) => {
        db.run("PRAGMA busy_timeout = 3000");
        const m = parsed(decodeJsonObject, readText(db, "auth_kv", key));
        if (!m) return;
        const next: Record<string, Schema.Json> = {
          ...m,
          access_token: c.access,
          refresh_token: c.refresh,
          expires_at: expires,
        };
        if (c.profile && c.method === "social") next.profile_arn = c.profile;
        db.query("UPDATE auth_kv SET value = ? WHERE key = ?").run(JSON.stringify(next), key);
      });
    } else if (c.idePath) {
      const path = c.idePath;
      const m = yield* readJson(path, decodeJsonObject);
      const next = { ...m, accessToken: c.access, refreshToken: c.refresh, expiresAt: expires };
      yield* Effect.tryPromise(() =>
        writeFile(path + ".opencode-tmp", JSON.stringify(next, null, 2), { mode: 0o600 })
      );
      yield* Effect.tryPromise(() => rename(path + ".opencode-tmp", path));
    }
  },
  (effect) => Effect.ignore(effect)
);

// ---- tokens --------------------------------------------------------------------

const NOT_SIGNED_IN = "Kiro isn't signed in. Run `kiro-cli login`, then try again.";
const EXPIRED = "Kiro's sign-in has expired. Run `kiro-cli login`, then try again.";
const EARLY_MS = 2 * 60 * 1000; // a token this close to its end is refreshed before a request
const fresh = (c: Cred, now: number) => !c.expires || c.expires - now > EARLY_MS;

// send makes a request with tracing off: OpenCode's tracer then adds no
// headers to what Kiro and AWS are sent, and records none of them. A
// request with a deadline fails with a TimeoutError that names the host.
const send = (request: HttpClientRequest.HttpClientRequest, seconds?: number) =>
  HttpClient.execute(request).pipe(
    seconds === undefined
      ? (e) => e
      : Effect.timeoutOrElse({
          duration: `${seconds} seconds`,
          orElse: () =>
            Effect.fail(
              new Cause.TimeoutError(
                `${new URL(request.url).host} didn't answer within ${seconds} seconds`
              )
            ),
        }),
    Effect.provideService(Tracer.DisablePropagation, true)
  );

// the fields the three token endpoints answer with, in their two spellings
const TokenAnswer = Schema.Struct({
  accessToken: field(Schema.String),
  refreshToken: field(Schema.String),
  expiresIn: field(Schema.Number),
  profileArn: field(Schema.String),
  access_token: field(Schema.String),
  refresh_token: field(Schema.String),
  expires_in: field(Schema.Number),
});

const refreshFailed = (e: { message: string }) =>
  Failure.RefreshError.make({ message: "Couldn't refresh Kiro's sign-in: " + e.message });

// tokenPost asks a token endpoint for a new token.
const tokenPost = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
  const res = yield* send(HttpClientRequest.acceptJson(request), 30).pipe(
    Effect.mapError(refreshFailed)
  );
  if ([400, 401, 403].includes(res.status))
    return yield* Failure.SignInError.make({ message: EXPIRED });
  if (res.status < 200 || res.status > 299)
    return yield* refreshFailed({
      message: `${new URL(request.url).host} answered HTTP ${res.status}`,
    });
  return yield* HttpClientResponse.schemaBodyJson(TokenAnswer)(res).pipe(
    Effect.mapError(refreshFailed)
  );
});

// kiroCli runs kiro-cli and waits for it to end, however it ends. It runs
// in the home directory, so nothing it might write lands in a project.
const kiroCli = (bin: string, args: string[]) =>
  Effect.callback<undefined>((resume) => {
    const child = execFile(bin, args, { timeout: 20_000, cwd: home() }, () =>
      resume(Effect.undefined)
    );
    return Effect.sync(() => {
      child.kill();
    });
  });

// refresh refreshes a sign-in's token the way its owner would, kiro-cli's
// by kiro-cli first.
const refresh = Effect.fnUntraced(function* (
  c: Cred
): Effect.fn.Return<Cred, Failure.SignInError | Failure.RefreshError, HttpClient.HttpClient> {
  if (c.dbKey) {
    const bin = yield* Effect.sync(kiroExecutable);
    if (bin) {
      yield* kiroCli(bin, ["debug", "refresh-auth-token"]);
      const n = yield* readCLI();
      const now = yield* Clock.currentTimeMillis;
      if (n && n.dbKey === c.dbKey && n.access !== c.access && fresh(n, now)) return n;
    }
  }
  if (!c.refresh) return yield* Failure.SignInError.make({ message: EXPIRED });
  let profile = c.profile;
  let out: { access?: string | null; refresh?: string | null; expiresIn?: number | null };
  if (c.method === "social") {
    const r = yield* tokenPost(
      HttpClientRequest.post(refreshURL(c.region)).pipe(
        HttpClientRequest.setHeader("User-Agent", DESKTOP_UA),
        HttpClientRequest.bodyText(JSON.stringify({ refreshToken: c.refresh }), "application/json")
      )
    );
    out = { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn };
    if (r.profileArn) profile = r.profileArn;
  } else if (c.method === "idc") {
    const r = yield* tokenPost(
      HttpClientRequest.post(oidc(c.region) + "/token").pipe(
        HttpClientRequest.bodyText(
          JSON.stringify({
            clientId: c.clientId,
            clientSecret: c.clientSecret,
            refreshToken: c.refresh,
            grantType: "refresh_token",
          }),
          "application/json"
        )
      )
    );
    out = { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn };
  } else {
    if (!c.tokenURL) return yield* Failure.SignInError.make({ message: EXPIRED });
    const r = yield* tokenPost(
      HttpClientRequest.post(c.tokenURL).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "refresh_token",
          client_id: c.clientId ?? "",
          refresh_token: c.refresh,
        })
      )
    );
    out = { access: r.access_token, refresh: r.refresh_token, expiresIn: r.expires_in };
  }
  if (!out.access) return yield* Failure.SignInError.make({ message: EXPIRED });
  const expiresIn = out.expiresIn && out.expiresIn > 0 ? out.expiresIn : 3600;
  const now = yield* Clock.currentTimeMillis;
  const n: Cred = { ...c, profile, access: out.access, expires: now + expiresIn * 1000 };
  if (out.refresh) n.refresh = out.refresh;
  yield* saveBack(n);
  return n;
});

// Auth is what a call to Kiro is made with.
interface Auth {
  token: string;
  tokenType: string;
  profile: string;
  region: string;
}

function authHeaders(a: Pick<Auth, "token" | "tokenType">) {
  const h: Record<string, string> = { Authorization: `Bearer ${a.token}` };
  if (a.tokenType) h.tokentype = a.tokenType;
  return h;
}
const tokenType = (c: Cred) => (c.method === "external-idp" ? "EXTERNAL_IDP" : "");

// regionOf is where the account's API is: the region its profile is in,
// else the nearer of Kiro's two to where it signed in.
function regionOf(profile: string, signedIn: string) {
  const parts = String(profile ?? "").split(":");
  if (parts.length > 4 && parts[3]) return parts[3];
  return String(signedIn ?? "").startsWith("eu-") ? "eu-central-1" : "us-east-1";
}

// managementCall calls Kiro's management API: GET with a query, or POST
// with a JSON body. decode reads the answer.
function managementCall<A>(
  decode: (u: unknown) => Effect.Effect<A, Schema.SchemaError>,
  region: string,
  a: Pick<Auth, "token" | "tokenType">,
  method: string,
  query: Record<string, string> | null,
  body?: object
): Effect.Effect<A, Failure.KiroApiError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const url = `${management(region)}/${method}`;
    const request = (
      body
        ? HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body)
        : HttpClientRequest.setUrlParams(HttpClientRequest.get(url), query ?? {})
    ).pipe(HttpClientRequest.setHeaders(authHeaders(a)), HttpClientRequest.acceptJson);
    const res = yield* send(request, 20).pipe(
      Effect.mapError((e) =>
        Failure.KiroApiError.make({
          status: 502,
          body: "",
          message: `Couldn't reach Kiro for ${method}: ${e.message}`,
        })
      )
    );
    if (res.status < 200 || res.status > 299)
      return yield* Failure.KiroApiError.fromReply(
        res.status,
        yield* res.text.pipe(Effect.orElseSucceed(() => ""))
      );
    return yield* res.json.pipe(
      Effect.flatMap(decode),
      Effect.mapError((e) =>
        Failure.KiroApiError.make({
          status: 502,
          body: "",
          message: `Kiro's ${method} answer didn't read as expected: ${e.message}`,
        })
      )
    );
  });
}

const decodeProfiles = Schema.decodeUnknownEffect(
  Schema.Struct({ profiles: field(Schema.Array(Schema.Struct({ arn: field(Schema.String) }))) })
);

// profileOf finds the profile for a sign-in that names none: Builder ID's,
// or the first Kiro lists in either of its regions.
const profileOf = Effect.fnUntraced(function* (
  c: Cred
): Effect.fn.Return<string, Failure.KiroApiError, HttpClient.HttpClient> {
  if (c.builderID) return BUILDER_ID_PROFILE;
  let last: Failure.KiroApiError | undefined;
  for (const region of ["us-east-1", "eu-central-1"]) {
    const out = yield* managementCall(
      decodeProfiles,
      region,
      { token: c.access, tokenType: tokenType(c) },
      "List-Available-Profiles",
      null,
      {}
    ).pipe(Effect.result);
    if (Result.isSuccess(out)) {
      const arn = (out.success.profiles ?? []).find((p) => p?.arn)?.arn;
      if (arn) return arn;
      continue;
    }
    // a Builder ID sign-in the token didn't say was one
    if (c.method === "idc" && out.failure.status === 403 && out.failure.body.includes("Builder ID"))
      return BUILDER_ID_PROFILE;
    last = out.failure;
  }
  return yield* (
    last ??
      Failure.KiroApiError.make({
        status: 502,
        body: "",
        message: "Kiro has no profile for this sign-in",
      })
  );
});

type AccountError = Failure.SignInError | Failure.RefreshError | Failure.KiroApiError;

// KiroAccount hands out the credentials to call Kiro with, read fresh from
// kiro-cli (or the IDE) each time and refreshed when near their end or
// turned down. One refresh runs at a time, since a refresh may replace the
// refresh token.
class KiroAccount extends Context.Service<
  KiroAccount,
  {
    // rejected is a token Kiro turned down: refreshed, unless its owner has already
    readonly credentials: (rejected?: string) => Effect.Effect<Auth, AccountError>;
  }
>()("opencode-kiro/KiroAccount") {
  static readonly layer = Layer.effect(
    KiroAccount,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const lock = yield* Semaphore.make(1);
      // what refreshing each access token gave, so a refresh whose save
      // didn't take isn't repeated with the refresh token it already spent
      const after = new Map<string, Cred>();
      const profiles = new Map<string | undefined, string>(); // sign-in → the profile Kiro listed for it

      const credentials = Effect.fn("KiroAccount.credentials")(
        function* (rejected?: string) {
          let c = (yield* readCLI()) ?? (yield* readIDE());
          if (!c) return yield* Failure.SignInError.make({ message: NOT_SIGNED_IN });
          for (let i = 0; i < 16; i++) {
            const n = after.get(c.access);
            if (!n) break;
            c = n;
          }
          if (!fresh(c, yield* Clock.currentTimeMillis) || c.access === rejected) {
            const n = yield* refresh(c);
            after.set(c.access, n);
            if (after.size > 16) after.delete(after.keys().next().value!);
            c = n;
          }
          const source = c.dbKey ?? c.idePath;
          if (!c.profile) c.profile = profiles.get(source) ?? (yield* profileOf(c));
          profiles.set(source, c.profile);
          return {
            token: c.access,
            tokenType: tokenType(c),
            profile: c.profile,
            region: regionOf(c.profile, c.region),
          };
        },
        lock.withPermits(1),
        Effect.provideService(HttpClient.HttpClient, http)
      );

      return KiroAccount.of({ credentials });
    })
  );
}

// ---- usage -----------------------------------------------------------------------

// Get-Usage-Limits is the account's usage this month, as kiro-cli's /usage
// shows it. Its userInfo (email, user id) is never read.
const amount = field(Schema.Number);
const when = field(Schema.Union([Schema.Number, Schema.String])); // epoch seconds, or a date
const Breakdown = Schema.Struct({
  displayName: field(Schema.String),
  displayNamePlural: field(Schema.String),
  resourceType: field(Schema.String),
  currency: field(Schema.String),
  currentUsage: amount,
  currentUsageWithPrecision: amount,
  usageLimit: amount,
  usageLimitWithPrecision: amount,
  currentOverages: amount,
  currentOveragesWithPrecision: amount,
  overageCharges: amount,
  overageRate: amount,
  overageCap: amount,
  overageCapWithPrecision: amount,
  nextDateReset: when,
  freeTrialInfo: field(
    Schema.Struct({
      freeTrialStatus: field(Schema.String),
      currentUsage: amount,
      currentUsageWithPrecision: amount,
      usageLimit: amount,
      usageLimitWithPrecision: amount,
      freeTrialExpiry: when,
    })
  ),
});
const decodeUsageLimits = Schema.decodeUnknownEffect(
  Schema.Struct({
    nextDateReset: when,
    overageConfiguration: field(Schema.Struct({ overageStatus: field(Schema.String) })),
    subscriptionInfo: field(Schema.Struct({ subscriptionTitle: field(Schema.String) })),
    usageBreakdownList: field(Schema.Array(Breakdown)),
  })
);

const millis = (t: number | string | null | undefined) => {
  if (typeof t === "number") return t > 1e12 ? t : t * 1000;
  const ms = typeof t === "string" ? Date.parse(t) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
};
// "KIRO PRO" is Kiro Pro
const planName = (title: string | null | undefined) =>
  (title || "Kiro").toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

function accountUsage(
  u: Effect.Success<ReturnType<typeof decodeUsageLimits>>,
  checkedAt: number
): AccountUsage {
  const enabled = u.overageConfiguration?.overageStatus === "ENABLED";
  const allowances: Allowance[] = [];
  let resetsAt = millis(u.nextDateReset);
  for (const b of u.usageBreakdownList ?? []) {
    if (!b) continue;
    const t = b.freeTrialInfo;
    const trial =
      t && t.freeTrialStatus === "ACTIVE"
        ? {
            used: t.currentUsageWithPrecision ?? t.currentUsage ?? 0,
            limit: t.usageLimitWithPrecision ?? t.usageLimit ?? 0,
            ...(millis(t.freeTrialExpiry) ? { expiresAt: millis(t.freeTrialExpiry) } : {}),
          }
        : undefined;
    const limit = b.usageLimitWithPrecision ?? b.usageLimit ?? 0;
    if (!limit && !trial?.limit) continue;
    const over = b.currentOveragesWithPrecision ?? b.currentOverages ?? 0;
    allowances.push({
      name: b.displayNamePlural || b.displayName || b.resourceType || "Credits",
      used: b.currentUsageWithPrecision ?? b.currentUsage ?? 0,
      limit,
      ...(enabled || over > 0 || b.overageCharges
        ? {
            overage: {
              credits: over,
              charges: b.overageCharges ?? 0,
              currency: b.currency || "USD",
              rate: b.overageRate ?? 0,
              cap: b.overageCapWithPrecision ?? b.overageCap ?? 0,
              enabled,
            },
          }
        : {}),
      ...(trial ? { trial } : {}),
    });
    resetsAt ||= millis(b.nextDateReset);
  }
  return { plan: planName(u.subscriptionInfo?.subscriptionTitle), resetsAt, allowances, checkedAt };
}

// readUsage reads the account's usage from Kiro
const readUsage = Effect.fnUntraced(function* (a: Auth) {
  const u = yield* managementCall(decodeUsageLimits, a.region, a, "Get-Usage-Limits", {
    origin: "KIRO_CLI",
    profileArn: a.profile,
    resourceType: "CREDIT",
  });
  return accountUsage(u, yield* Clock.currentTimeMillis);
});

// what each session has spent, kept in the plugin's storage
const creditsKey = (sessionID: string) => `credits/${sessionID}`;
const decodeCredits = Schema.decodeUnknownOption(Schema.Number);
const decodeUsageInput = Schema.decodeUnknownEffect(
  Schema.Struct({ sessionIDs: Schema.Array(Schema.String) })
);

// ---- models ----------------------------------------------------------------------

// Each model Kiro lists says which request fields it takes for thinking
// (additionalModelRequestFieldsSchema): Claude 4.6 and later take Anthropic's
// adaptive thinking with an effort, GPT takes a reasoning effort. Models it
// lists none for (Auto, Claude 4.5) are asked to think in the prompt, with a
// budget, as kiro-cli asked before the fields existed.
const BUDGETS: Record<string, number> = {
  low: 10000,
  medium: 20000,
  high: 30000,
  xhigh: 50000,
  max: 50000,
};
const PROMPT_EFFORTS = ["low", "medium", "high", "max"];
const thinks = (id: string) => /claude/i.test(id) || id === "auto";

// KiroModel is a model as Kiro lists it, kept in the plugin's storage
// between runs. fields is the request fields it takes for thinking:
// Anthropic's, OpenAI's, or none.
const KiroModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  context: Schema.Number,
  output: Schema.Number,
  images: Schema.Boolean,
  fields: Schema.Literals(["claude", "openai", ""]),
  efforts: Schema.Array(Schema.String),
  off: Schema.optional(Schema.Boolean), // thinking can be turned off
  summarized: Schema.optional(Schema.Boolean), // the thinking can be summarized
  maxTokens: Schema.optional(Schema.Tuple([Schema.Number, Schema.Number])),
});
type KiroModel = typeof KiroModel.Type;

// a list saved by an earlier run, if it still reads as one
const decodeSaved = Schema.decodeUnknownOption(Schema.NonEmptyArray(KiroModel));

// until Kiro has listed the account's models: Auto, which picks one for each request
const FALLBACK: readonly KiroModel[] = [
  {
    id: "auto",
    name: "Auto",
    context: 200000,
    output: 64000,
    images: true,
    fields: "",
    efforts: [],
  },
];

// a JSON schema's enum, as a model's request fields give one
const Enum = field(Schema.Struct({ enum: field(Schema.Array(Schema.Unknown)) }));

// a model as List-Available-Models gives it
const ListedModel = Schema.Struct({
  modelId: Schema.String,
  modelName: field(Schema.String),
  tokenLimits: field(
    Schema.Struct({ maxInputTokens: field(Schema.Number), maxOutputTokens: field(Schema.Number) })
  ),
  supportedInputTypes: field(Schema.Array(Schema.Unknown)),
  additionalModelRequestFieldsSchema: field(
    Schema.Struct({
      properties: field(
        Schema.Struct({
          thinking: field(
            Schema.Struct({ properties: field(Schema.Struct({ type: Enum, display: Enum })) })
          ),
          output_config: field(
            Schema.Struct({ properties: field(Schema.Struct({ effort: Enum })) })
          ),
          reasoning: field(Schema.Struct({ properties: field(Schema.Struct({ effort: Enum })) })),
          max_tokens: field(
            Schema.Struct({ minimum: field(Schema.Number), maximum: field(Schema.Number) })
          ),
        })
      ),
    })
  ),
});
type ListedModel = typeof ListedModel.Type;
const decodeListedModel = Schema.decodeUnknownOption(ListedModel);

// a page of List-Available-Models; each model is read on its own, so one
// Kiro lists in a shape this doesn't know leaves the rest
const decodeModelsPage = Schema.decodeUnknownEffect(
  Schema.Struct({
    models: field(Schema.Array(Schema.Unknown)),
    defaultModel: field(Schema.Struct({ modelId: field(Schema.String) })),
    nextToken: field(Schema.String),
  })
);

function modelOf(m: ListedModel): KiroModel {
  const fields = m.additionalModelRequestFieldsSchema?.properties ?? {};
  const thinking = fields.thinking?.properties ?? {};
  const style = fields.output_config ? "claude" : fields.reasoning ? "openai" : "";
  const efforts =
    (style === "claude"
      ? fields.output_config?.properties?.effort?.enum
      : fields.reasoning?.properties?.effort?.enum) ?? [];
  const maxTokens = fields.max_tokens;
  let name = m.modelName;
  if (!name || name === m.modelId) name = m.modelId === "auto" ? "Auto" : m.modelId;
  return {
    id: m.modelId,
    name,
    context: m.tokenLimits?.maxInputTokens ?? 0,
    output: m.tokenLimits?.maxOutputTokens ?? 0,
    images: (m.supportedInputTypes ?? []).some((t) => String(t).toUpperCase() === "IMAGE"),
    fields: style,
    efforts: efforts.filter((e): e is string => typeof e === "string"),
    off: (thinking.type?.enum ?? []).includes("disabled"),
    summarized: (thinking.display?.enum ?? []).includes("summarized"),
    ...(maxTokens?.maximum && maxTokens.maximum > 0
      ? { maxTokens: [maxTokens.minimum ?? 1, maxTokens.maximum] as const }
      : {}),
  };
}

// listModels is List-Available-Models, every page of it, the default first.
const listModels = Effect.fnUntraced(function* (a: Auth) {
  const list: KiroModel[] = [];
  let defaultModel: string | undefined;
  let next: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = yield* managementCall(decodeModelsPage, a.region, a, "List-Available-Models", {
      origin: "KIRO_CLI",
      profileArn: a.profile,
      ...(next ? { nextToken: next } : {}),
    });
    defaultModel ??= page.defaultModel?.modelId ?? undefined;
    for (const m of page.models ?? []) {
      const listed = decodeListedModel(m);
      if (Option.isSome(listed)) list.push(modelOf(listed.value));
    }
    next = page.nextToken ?? undefined;
    if (!next) break;
  }
  if (!list.length)
    return yield* Failure.KiroApiError.make({
      status: 502,
      body: "",
      message: "Kiro listed no models",
    });
  const i = list.findIndex((m) => m.id === defaultModel);
  if (i > 0) list.unshift(...list.splice(i, 1));
  return list;
});

function variantsOf(m: KiroModel): Model.Variant[] {
  let levels: readonly string[] = [];
  if (m.fields === "claude") levels = [...(m.off ? ["none"] : []), ...m.efforts];
  else if (m.fields === "openai") levels = m.efforts;
  else if (thinks(m.id)) levels = PROMPT_EFFORTS;
  // each level reaches http.request as the body's output_config.effort
  return levels.map((effort) => ({ id: effort as Model.VariantID, settings: { effort } }));
}

// modelInfo is a model as OpenCode's catalog holds it.
function modelInfo(m: KiroModel): Model.Info {
  return {
    id: m.id as Model.ID,
    modelID: m.id as Model.ID,
    providerID: ID as Provider.ID,
    name: m.name,
    capabilities: { tools: true, input: m.images ? ["text", "image"] : ["text"], output: ["text"] },
    variants: variantsOf(m),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: m.context || 200000, output: m.output || 32000 },
    // the Anthropic route would send these for Claude 5 by its model id; Kiro takes neither
    compatibility: { supportsEffortUpdates: false, supportsThinkingBlockBinding: false },
  };
}

const PROVIDER: Provider.Info = {
  id: ID as Provider.ID,
  name: "Kiro",
  // available without a connection in OpenCode: the sign-in is kiro-cli's
  activation: "enabled",
  package: PACKAGE,
  settings: {
    baseURL: BASE,
    // OpenCode times the response headers up to the end of http.response,
    // which waits for Kiro's first event. At its default, 5 minutes, it
    // would cut off a slow first event before the stall check said why.
    headerTimeout: (HEADERS_SECONDS + IDLE_SECONDS) * 1000,
  },
};

// ---- the request: Messages → a Kiro conversation ---------------------------------------

// The parts of an Anthropic Messages request the plugin reads. OpenCode's
// own Anthropic route writes it, so it is taken to be of this shape, and
// every field is still read as if it might be missing.
interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Block[];
  title?: string;
  source?: { type?: string; data?: string; media_type?: string; content?: string | Block[] };
  cache_control?: unknown;
}
interface Message {
  role?: string;
  content?: string | Block[];
}
interface Tool {
  name?: string;
  type?: string;
  description?: string;
  input_schema?: unknown;
  cache_control?: unknown;
}
interface OutputFormat {
  type?: string;
  schema?: unknown;
}
interface MessagesRequest {
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  system?: string | Block[];
  messages?: Message[];
  tools?: Tool[];
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string; format?: OutputFormat };
  output_format?: OutputFormat;
}

// A Kiro conversation, as generateAssistantResponse takes it.
interface KiroImage {
  format: string;
  source: { bytes: string };
}
interface ToolResult {
  toolUseId: string;
  status: "success" | "error";
  content: { text: string }[];
}
type CachePoint = { type: "default" };
type KiroTool =
  | {
      toolSpecification: { name: string; description: string; inputSchema: { json: unknown } };
      cachePoint?: never;
    }
  | { cachePoint: CachePoint; toolSpecification?: never };
interface UserInput {
  content: string;
  modelId: string;
  origin: "KIRO_CLI";
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: ToolResult[]; tools?: KiroTool[] };
  cachePoint?: CachePoint;
}
interface ToolUse {
  name: string;
  toolUseId: string;
  input: object;
}
interface AssistantResponse {
  content: string;
  toolUses?: ToolUse[];
  cachePoint?: CachePoint;
}
interface Entry {
  userInputMessage?: UserInput;
  assistantResponseMessage?: AssistantResponse;
}
// the thinking fields Kiro passes on to the model
interface Fields {
  thinking?: { type: "adaptive" | "disabled"; display?: "summarized" };
  output_config?: { effort: string };
  reasoning?: { effort: string };
  max_tokens?: number;
}
interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: UserInput };
    history?: Entry[];
  };
  agentMode: "vibe";
  profileArn?: string;
  additionalModelRequestFields?: Fields;
}

const PROCEED = "Please proceed with the task."; // Kiro takes no empty message
const NO_RESULT = "Tool use was interrupted and did not produce a result.";
const RESULT_LIMIT = 250000; // a tool's output is cut at this, as Kiro's own agent cuts it
const TOOL_ID = /^[a-zA-Z0-9_.:-]{1,64}$/;

// toolID is a tool call's id as Kiro takes one: another vendor's becomes
// one of Kiro's own, the same each time.
const toolID = (id: string | undefined) =>
  id && TOOL_ID.test(id)
    ? id
    : "t_" +
      createHash("sha256")
        .update(String(id ?? ""))
        .digest("base64url")
        .slice(0, 32);

// Kiro answers a tool named past 64 characters, or outside these, "Invalid
// tool use format." and won't raise the limit (kirodotdev/Kiro#7684), and
// MCP tool names can run longer.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// toolName is a tool's name as Kiro takes one: another is its head with a
// hash of the whole name, the same each time, so later turns name it the
// same way. toolNames maps each such name back.
const toolName = (name: string | undefined) => {
  const n = String(name ?? "");
  if (TOOL_NAME.test(n)) return n;
  const hash = createHash("sha256").update(n).digest("hex").slice(0, 12);
  return n.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64 - 1 - hash.length) + "_" + hash;
};

// toolNames is the name the caller knows for each tool a request names that
// Kiro is sent under another name.
function toolNames(req: MessagesRequest) {
  const names = new Map<string, string>();
  const add = (n: unknown) => {
    if (typeof n !== "string" || !n) return;
    const k = toolName(n);
    if (k !== n) names.set(k, n);
  };
  for (const t of req.tools ?? []) add(t?.name);
  for (const m of req.messages ?? [])
    if (Array.isArray(m.content))
      for (const p of m.content) if (p?.type === "tool_use") add(p.name);
  return names;
}

function imageFormat(mediaType: string | undefined) {
  const t = String(mediaType ?? "").toLowerCase();
  const f = t.replace(/^image\//, "");
  if (f === "jpg") return "jpeg";
  if (!f || f === t) return "png";
  return f;
}

// addImage puts an Anthropic image block in images as Kiro takes it, the
// bytes inline. One named only by a URL has no bytes to send and is left out.
function addImage(images: KiroImage[], p: Block) {
  if (p.source?.type === "base64" && p.source.data)
    images.push({ format: imageFormat(p.source.media_type), source: { bytes: p.source.data } });
}

const textOf = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .filter((p: Block) => p?.type === "text")
          .map((p: Block) => p.text ?? "")
          .join("\n\n")
      : "";
const joinNonEmpty = (a: string, b: string) => (a && b ? a + "\n\n" + b : a + b);

function documentText(p: Block) {
  const title = p.title ? `${p.title}\n` : "";
  if (p.source?.type === "text") return title + (p.source.data ?? "");
  if (p.source?.type === "content") return title + textOf(p.source.content);
  return `${title}[a ${p.source?.media_type ?? "document"} attachment]`;
}

// Thinking is how the model is asked to think: request fields, or a budget
// told in the prompt.
interface Thinking {
  budget?: number;
  fields?: Fields;
}

// thinkingOf is how the model is asked to think, from the effort the
// variant set (output_config.effort): the request fields Kiro lists for the
// model (m), or, for a model it lists none for, a thinking budget for the
// prompt.
function thinkingOf(req: MessagesRequest, model: string, m: KiroModel | undefined): Thinking {
  const effort = req.output_config?.effort;
  if (m?.fields) {
    if (!effort) return {};
    const fields: Fields = {};
    if (m.fields === "openai") {
      if (m.efforts.includes(effort)) fields.reasoning = { effort };
    } else if (effort === "none") {
      if (m.off) fields.thinking = { type: "disabled" };
    } else if (m.efforts.includes(effort)) {
      fields.thinking = { type: "adaptive", ...(m.summarized ? { display: "summarized" } : {}) };
      fields.output_config = { effort };
    }
    if (m.maxTokens && req.max_tokens && req.max_tokens > 0)
      fields.max_tokens = Math.min(Math.max(req.max_tokens, m.maxTokens[0]), m.maxTokens[1]);
    return Object.keys(fields).length ? { fields } : {};
  }
  if (!thinks(model)) return {};
  if (
    req.thinking?.type === "enabled" &&
    req.thinking.budget_tokens &&
    req.thinking.budget_tokens > 0
  )
    return { budget: req.thinking.budget_tokens };
  const budget = effort ? BUDGETS[effort] : undefined;
  return budget ? { budget } : {};
}

// formatText is the structured output a request asks for, said in words:
// output_config.format with a JSON schema, "" when it asks for none.
function formatText(req: MessagesRequest) {
  const f = req.output_config?.format ?? req.output_format;
  if (f?.type !== "json_schema" || !f.schema || typeof f.schema !== "object") return "";
  return (
    "Respond with a single JSON value and nothing else, matching this JSON schema:\n" +
    JSON.stringify(f.schema) +
    "."
  );
}

function kiroRequest(
  req: MessagesRequest,
  model: string,
  profile: string,
  { budget, fields }: Thinking = {}
): KiroRequest {
  const entries: Entry[] = [];
  // the messages the caller marked for its prompt cache (cache_control),
  // which go to Kiro as a cachePoint on the message they end up in
  const marked = new WeakSet<UserInput | AssistantResponse>();
  const mark = (msg: UserInput | AssistantResponse, parts: Block[]) => {
    if (parts.some((p) => p?.cache_control)) marked.add(msg);
  };
  const user = (): UserInput => ({ content: "", modelId: model, origin: "KIRO_CLI" });
  for (const m of req.messages ?? []) {
    const parts: Block[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    // Kiro has no system role mid-conversation: an update's text is said as
    // the user's, and one with no text (an effort change) is dropped
    if (m.role === "system" && !parts.some((p) => p?.type === "text" && p.text)) continue;
    const texts: string[] = [];
    if (m.role === "assistant") {
      const a: AssistantResponse = { content: "", toolUses: [] };
      for (const p of parts) {
        if (p?.type === "text" && p.text) texts.push(p.text);
        else if (p?.type === "tool_use") {
          const input =
            p.input && typeof p.input === "object" && !Array.isArray(p.input) ? p.input : {};
          a.toolUses!.push({ name: toolName(p.name), toolUseId: toolID(p.id), input });
        }
      }
      a.content = texts.join("\n\n");
      if (!a.content && !a.toolUses!.length) continue; // a turn that only thought
      const prev = entries.at(-1)?.assistantResponseMessage;
      if (prev) {
        prev.content = joinNonEmpty(prev.content, a.content);
        prev.toolUses!.push(...a.toolUses!);
      } else entries.push({ assistantResponseMessage: a });
      mark(prev ?? a, parts);
      continue;
    }
    const u = user();
    const images: KiroImage[] = [];
    u.images = images;
    const results: ToolResult[] = [];
    for (const p of parts) {
      if (p?.type === "text") {
        if (p.text) texts.push(p.text);
      } else if (p?.type === "document") texts.push(documentText(p));
      else if (p?.type === "image") addImage(images, p);
      else if (p?.type === "tool_result") {
        let out = textOf(p.content);
        if (out.length > RESULT_LIMIT) out = out.slice(0, RESULT_LIMIT) + "\n… (cut)";
        results.push({
          toolUseId: toolID(p.tool_use_id),
          status: p.is_error ? "error" : "success",
          content: [{ text: out || "(no output)" }],
        });
        // a tool's images (a screenshot) go with the message, as Kiro's tool
        // results carry text alone
        if (Array.isArray(p.content))
          for (const c of p.content) if (c?.type === "image") addImage(images, c);
      }
    }
    u.content = texts.join("\n\n");
    if (results.length) u.userInputMessageContext = { toolResults: results };
    const prev = entries.at(-1)?.userInputMessage;
    if (prev) {
      prev.content = joinNonEmpty(prev.content, u.content);
      prev.images!.push(...images);
      if (results.length)
        (prev.userInputMessageContext ??= { toolResults: [] }).toolResults!.push(...results);
    } else entries.push({ userInputMessage: u });
    mark(prev ?? u, parts);
  }
  // the conversation opens with something the user said: tool results with
  // no call before them go, and so does a reply the caller began with
  while (entries.length) {
    const u = entries[0]?.userInputMessage;
    if (u) {
      if (u.userInputMessageContext && !u.content && !u.images?.length) {
        entries.shift();
        continue;
      }
      delete u.userInputMessageContext;
      break;
    }
    entries.shift();
  }
  // and ends with it, the message being answered
  let current = entries.at(-1)?.userInputMessage;
  if (!current) {
    current = { ...user(), images: [] };
    entries.push({ userInputMessage: current });
  }
  // each call is answered in the message after it, and only calls are
  entries.forEach((e, i) => {
    const u = e.userInputMessage;
    if (!u) return;
    const calls = entries[i - 1]?.assistantResponseMessage?.toolUses ?? [];
    const results = u.userInputMessageContext?.toolResults ?? [];
    const answered = new Set<string>();
    const kept: ToolResult[] = [];
    for (const r of results)
      if (!answered.has(r.toolUseId) && calls.some((c) => c.toolUseId === r.toolUseId)) {
        answered.add(r.toolUseId);
        kept.push(r);
      }
    for (const c of calls)
      if (!answered.has(c.toolUseId)) {
        answered.add(c.toolUseId);
        kept.push({ toolUseId: c.toolUseId, status: "error", content: [{ text: NO_RESULT }] });
      }
    delete u.userInputMessageContext;
    if (kept.length) u.userInputMessageContext = { toolResults: kept };
    if (!u.content && !u.userInputMessageContext) u.content = PROCEED;
  });
  // only the latest images are sent again, as Kiro's own agent does
  let latest = -1;
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i]?.userInputMessage?.images?.length) {
      latest = i;
      break;
    }
  entries.forEach((e, i) => {
    const u = e.userInputMessage;
    if (u && (i !== latest || !u.images?.length)) delete u.images;
  });
  for (const e of entries)
    if (e.assistantResponseMessage && !e.assistantResponseMessage.toolUses?.length)
      delete e.assistantResponseMessage.toolUses;
  // the instructions go at the head of the first message, which the loops
  // above made the user's
  const first = entries[0]?.userInputMessage ?? current;
  let system = typeof req.system === "string" ? req.system : textOf(req.system);
  // Kiro has no field for the answer's format, so it is told in words
  const format = formatText(req);
  if (format) system = system ? system + "\n\n" + format : format;
  if (budget)
    system =
      `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>` +
      (system ? "\n" + system : "");
  if (system) first.content = system + "\n\n" + first.content;
  if (Array.isArray(req.system)) mark(first, req.system);

  // the caller's tools, and any the conversation used that it no longer
  // offers, since Kiro rejects a history naming a tool it wasn't given
  const tools: KiroTool[] = [];
  const offered = new Set<string>();
  const EMPTY = { type: "object", properties: {} };
  for (const t of req.tools ?? []) {
    if (!t?.name || (t.type && t.type !== "custom" && !t.input_schema)) continue; // server tools Kiro hasn't
    const name = toolName(t.name);
    offered.add(name);
    tools.push({
      toolSpecification: {
        name,
        description: t.description || t.name,
        inputSchema: { json: t.input_schema ?? EMPTY },
      },
    });
    if (t.cache_control) tools.push({ cachePoint: { type: "default" } });
  }
  for (const e of entries)
    for (const c of e.assistantResponseMessage?.toolUses ?? [])
      if (!offered.has(c.name)) {
        offered.add(c.name);
        tools.push({
          toolSpecification: { name: c.name, description: "Tool", inputSchema: { json: EMPTY } },
        });
      }
  if (tools.length) (current.userInputMessageContext ??= {}).tools = tools;
  // Kiro's cachePoint is Bedrock's: it caches the prompt up to the point, and
  // a request may hold 4 at most; past that the last ones are kept, as they
  // cover the most of the prompt
  const points: (() => void)[] = [];
  for (const t of tools)
    if (t.cachePoint)
      points.push(() => {
        tools.splice(tools.indexOf(t), 1);
      });
  for (const e of entries) {
    const msg = e.userInputMessage ?? e.assistantResponseMessage;
    if (msg && marked.has(msg)) {
      msg.cachePoint = { type: "default" };
      points.push(() => {
        delete msg.cachePoint;
      });
    }
  }
  for (const drop of points.slice(0, Math.max(0, points.length - 4))) drop();

  const out: KiroRequest = {
    conversationState: {
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
      conversationId: randomUUID(),
      currentMessage: { userInputMessage: current },
    },
    agentMode: "vibe",
  };
  if (entries.length > 1) out.conversationState.history = entries.slice(0, -1);
  if (profile) out.profileArn = profile;
  if (fields) out.additionalModelRequestFields = fields;
  return out;
}

// kiroCall is a generateAssistantResponse request, with kiro-cli's headers.
function kiroCall(a: Auth, body: string) {
  const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${randomUUID().replaceAll("-", "")}`;
  return HttpClientRequest.post(runtime(a.region) + "/generateAssistantResponse").pipe(
    HttpClientRequest.setHeaders({
      ...authHeaders(a),
      Accept: "application/vnd.amazon.eventstream",
      "x-amzn-codewhisperer-optout": "true",
      "amz-sdk-invocation-id": randomUUID(),
      "amz-sdk-request": "attempt=1; max=1",
      "x-amzn-kiro-agent-mode": "vibe",
      "x-amz-user-agent": ua,
      "User-Agent": ua,
    }),
    HttpClientRequest.bodyText(body, "application/json")
  );
}

// ---- images over Kiro's size limit ---------------------------------------------------
//
// Kiro turns away an image whose Base64 is over 5 MiB, counted on the encoded
// string, not the file (magpie-community/plugins#428), and the image stays in
// history, so every later turn would fail the same way. An image over the
// limit is made smaller on the request being sent, and one that can't be is
// replaced by a note.
const IMAGE_LIMIT = 5 * 1024 * 1024; // Base64 characters
const IMAGE_EDGE = 2000; // a shrunk image's long edge (kirodotdev/Kiro#8884)
const IMAGE_MIN_EDGE = 256;
const IMAGE_MAX_PIXELS = 50_000_000; // a header claiming more is refused unread
const IMAGE_MAX_INPUT = 64 * 1024 * 1024; // Base64 characters looked at all
const IMAGE_DEADLINE = "30 seconds"; // how long one image may take
const FITTED_KEEP = 4;

type Fitted = { format: string; bytes: string; note?: never } | { note: string; bytes?: never };

const mib = (n: number) => (n / (1024 * 1024)).toFixed(1) + " MB";

// an encoding to try: the format, and how to set it on an image
type Encoding = { format: string; encode: (img: Bun.Image) => Bun.Image };

// shrink tries the image's own format at Claude's size, then a lossy one
// (WebP keeps transparency, JPEG stays JPEG) smaller each time, until the
// Base64 fits.
const shrink = Effect.fnUntraced(
  function* (b64: string): Effect.fn.Return<Fitted> {
    if (typeof globalThis.Bun?.Image !== "function")
      return { note: "this plugin host can't resize images" };
    const raw = Buffer.from(b64, "base64");
    const meta = yield* Effect.tryPromise({
      try: () => new Bun.Image(raw, { maxPixels: IMAGE_MAX_PIXELS }).metadata(),
      catch: (e) => ({ code: codeOf(e) }),
    }).pipe(Effect.result);
    if (Result.isFailure(meta))
      return {
        note:
          meta.failure.code === "ERR_IMAGE_TOO_MANY_PIXELS"
            ? "it has too many pixels to resize"
            : "it couldn't be read as an image",
      };
    const { width, height, format } = meta.success;
    const long = Math.max(width, height);
    const jpeg = format === "jpeg";
    const own: Encoding = jpeg
      ? { format: "jpeg", encode: (img) => img.jpeg({ quality: 85 }) }
      : format === "webp"
        ? { format: "webp", encode: (img) => img.webp({ quality: 85 }) }
        : { format: "png", encode: (img) => img.png({ compressionLevel: 9 }) };
    const lossy = (quality: number): Encoding =>
      jpeg
        ? { format: "jpeg", encode: (img) => img.jpeg({ quality }) }
        : { format: "webp", encode: (img) => img.webp({ quality }) };
    const tries = [
      { edge: Math.min(long, IMAGE_EDGE), ...own },
      { edge: Math.min(long, IMAGE_EDGE), ...lossy(80) },
    ];
    for (let edge = Math.min(long, IMAGE_EDGE) * 0.7; edge >= IMAGE_MIN_EDGE; edge *= 0.7)
      tries.push({ edge: Math.round(edge), ...lossy(75) });
    for (const t of tries) {
      const out = yield* Effect.tryPromise({
        try: () => {
          let img = new Bun.Image(raw, { maxPixels: IMAGE_MAX_PIXELS });
          if (t.edge < long)
            img = img.resize(t.edge, t.edge, { fit: "inside", withoutEnlargement: true });
          return t.encode(img).toBase64();
        },
        catch: (e) => ({ code: codeOf(e) }),
      }).pipe(Effect.result);
      if (Result.isFailure(out)) {
        if (out.failure.code === "ERR_IMAGE_FORMAT_UNSUPPORTED") continue;
        return { note: "it couldn't be resized" };
      }
      if (out.success.length <= IMAGE_LIMIT) return { format: t.format, bytes: out.success };
    }
    return { note: "it couldn't be made small enough" };
  },
  Effect.timeoutOrElse({
    duration: IMAGE_DEADLINE,
    orElse: () => Effect.succeed({ note: "resizing it took too long" }),
  }),
  Effect.catchDefect(() => Effect.succeed({ note: "it couldn't be resized" }))
);

// Images brings every image left in a built request under Kiro's limit.
// The last few results are kept, as an image stays in the conversation and
// is sent again with the turns after it.
class Images extends Context.Service<
  Images,
  { readonly fit: (out: KiroRequest) => Effect.Effect<KiroRequest> }
>()("opencode-kiro/Images") {
  static readonly layer = Layer.sync(Images, () => {
    const fitted = new Map<string, Fitted>(); // sha256 of the Base64 → the result, newest last

    const fitOne = Effect.fnUntraced(function* (b64: string) {
      const key = createHash("sha256").update(b64).digest("hex");
      let r = fitted.get(key);
      if (r) fitted.delete(key); // kept as the newest below
      else
        r =
          b64.length > IMAGE_MAX_INPUT ? { note: "it is too large to resize" } : yield* shrink(b64);
      fitted.set(key, r);
      while (fitted.size > FITTED_KEEP) fitted.delete(fitted.keys().next().value!);
      return r;
    });

    // fit changes the request in place; an image already under the limit is sent as it is
    const fit = Effect.fn("Images.fit")(function* (out: KiroRequest) {
      const s = out.conversationState;
      const users = [
        ...(s.history ?? []).map((e) => e.userInputMessage),
        s.currentMessage.userInputMessage,
      ].filter((u): u is UserInput => !!u);
      for (const u of users) {
        if (!u.images?.length) continue;
        const kept: KiroImage[] = [];
        const notes: string[] = [];
        for (const img of u.images) {
          const b64 = img.source?.bytes;
          if (typeof b64 !== "string" || b64.length <= IMAGE_LIMIT) {
            kept.push(img);
            continue;
          }
          const r = yield* fitOne(b64);
          if (r.bytes)
            kept.push({ ...img, format: r.format, source: { ...img.source, bytes: r.bytes } });
          else
            notes.push(
              `[An image (${img.format}, ${mib(b64.length)} as Base64) was left out of this message: Kiro takes at most ${mib(IMAGE_LIMIT)} per image, and ${r.note}.]`
            );
        }
        if (kept.length) u.images = kept;
        else delete u.images;
        if (notes.length) u.content = joinNonEmpty(u.content, notes.join("\n"));
      }
      return out;
    });

    return Images.of({ fit });
  });
}

// ---- the reply: an AWS event stream → Messages ---------------------------------------

// the size of each header value type that isn't a string or bytes
const HEADER_SIZES: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };

function frameHeaders(h: Uint8Array) {
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  let i = 0;
  while (i < h.length) {
    const n = v.getUint8(i);
    if (h.length < i + 2 + n) break;
    const name = dec.decode(h.subarray(i + 1, i + 1 + n));
    const type = v.getUint8(i + 1 + n);
    i += 2 + n;
    if (type === 6 || type === 7) {
      if (h.length < i + 2) break;
      const l = v.getUint16(i);
      if (h.length < i + 2 + l) break;
      if (type === 7) out[name] = dec.decode(h.subarray(i + 2, i + 2 + l));
      i += 2 + l;
      continue;
    }
    const size = HEADER_SIZES[type];
    if (size === undefined || h.length < i + size) break;
    i += size;
  }
  return out;
}

// ThinkParser splits a reply that opens with <thinking>…</thinking> into its
// thinking and the text after, however the tags fall across pieces.
const OPEN = "<thinking>";
const CLOSE = "</thinking>";
function partialSuffix(s: string, tag: string) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--)
    if (s.endsWith(tag.slice(0, n))) return n;
  return 0;
}

type Said = { kind: "text" | "think"; text: string };

class ThinkParser {
  state = 0; // 0: not yet known, 1: thinking, 2: text
  buf = "";
  said = false;
  feed(s: string): Said[] {
    this.buf += s;
    const out: Said[] = [];
    for (;;) {
      if (this.state === 0) {
        const t = this.buf.replace(/^[ \t\r\n]+/, "");
        if (t.startsWith(OPEN)) {
          [this.buf, this.state] = [t.slice(OPEN.length), 1];
          continue;
        }
        if (t.length < OPEN.length && OPEN.startsWith(t)) return out; // may yet be the tag
        this.state = 2;
        continue;
      }
      if (this.state === 1) {
        if (!this.said) {
          this.buf = this.buf.replace(/^[\r\n]+/, "");
          if (!this.buf) return out;
        }
        const i = this.buf.indexOf(CLOSE);
        if (i !== -1) {
          if (i > 0) {
            out.push({ kind: "think", text: this.buf.slice(0, i) });
            this.said = true;
          }
          [this.buf, this.state] = [this.buf.slice(i + CLOSE.length).replace(/^[\r\n]+/, ""), 2];
          continue;
        }
        // hold back what may be the start of the closing tag
        const n = this.buf.length - partialSuffix(this.buf, CLOSE);
        if (n > 0) {
          out.push({ kind: "think", text: this.buf.slice(0, n) });
          [this.buf, this.said] = [this.buf.slice(n), true];
        }
        return out;
      }
      if (this.buf) out.push({ kind: "text", text: this.buf });
      this.buf = "";
      return out;
    }
  }
  end(): Said[] {
    if (!this.buf) return [];
    const ev: Said = { kind: this.state === 1 ? "think" : "text", text: this.buf };
    this.buf = "";
    if (this.state === 0) this.state = 2;
    return [ev];
  }
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reported: boolean; // Kiro sent token counts
  credits: number; // what the reply cost, from its meteringEvents
}

// KiroEvent is a piece of Kiro's reply, as reply turns it into Messages events.
type KiroEvent =
  | Said
  | { kind: "sig" | "toolArgs"; text: string }
  | { kind: "toolStart"; id: string; name: string }
  | ({ kind: "error" } & Failure.Failure)
  | { kind: "stop"; reason: string; usage: Usage };

// what the payload of each event Kiro sends may hold
const count = field(Schema.Number);
const Payload = Schema.Struct({
  content: Schema.optional(Schema.Unknown),
  text: field(Schema.String),
  signature: field(Schema.String),
  toolUseId: field(Schema.String),
  name: field(Schema.String),
  input: Schema.optional(Schema.Unknown),
  stopReason: field(Schema.String),
  contextUsagePercentage: count,
  usage: count, // a meteringEvent's credits
  tokenUsage: field(
    Schema.Struct({
      uncachedInputTokens: count,
      inputTokens: count,
      outputTokens: count,
      cacheReadInputTokens: count,
      cacheWriteInputTokens: count,
      contextUsagePercentage: count,
    })
  ),
});
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Payload));

const FAILURE_EVENTS = new Set([
  "error",
  "throttlingError",
  "validationError",
  "serviceUnavailableError",
  "internalServerException",
]);

// ReplyDecoder reads Kiro's reply, an AWS event stream, piece by piece into
// events: text, thinking, tool calls (the arguments in pieces), then the
// usage and why it stopped, or an error. Each message of the stream is its
// length, its headers' length and a checksum, the headers, the payload, and
// a checksum of the whole.
class ReplyDecoder {
  private buf: Uint8Array = new Uint8Array(0);
  private readonly think = new ThinkParser();
  private tool = "";
  private tools = 0;
  private stop = "";
  // Kiro sends no token counts today, only how full the context is
  // (contextUsageEvent) and the credits spent (meteringEvent)
  private readonly usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reported: false,
    credits: 0,
  };
  private pct = 0;
  private said = 0;
  private failed: Failure.Failure | undefined;
  private ended = false;

  constructor(
    private readonly window: number, // the model's context, to reckon the input from
    private readonly budget: number | undefined // the thinking budget the prompt set
  ) {}

  // done is whether the reply has failed, so no more of it need be read
  get done() {
    return this.failed !== undefined;
  }

  // push reads a piece of the body: the events of each message it completes.
  push(chunk: Uint8Array): KiroEvent[] {
    const out: KiroEvent[] = [];
    const n = new Uint8Array(this.buf.length + chunk.length);
    n.set(this.buf);
    n.set(chunk, this.buf.length);
    this.buf = n;
    while (!this.failed && this.buf.length >= 12) {
      const v = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const total = v.getUint32(0);
      const hlen = v.getUint32(4);
      if (total < 16 || total > 16 << 20 || hlen > total - 16) {
        this.broke("its event stream was malformed");
        break;
      }
      if (this.buf.length < total) break;
      const rest = this.buf.subarray(12, total);
      this.message(frameHeaders(rest.subarray(0, hlen)), rest.subarray(hlen, -4), out);
      this.buf = this.buf.slice(total);
    }
    return out;
  }

  // broke is the body failing before its end
  broke(message: string) {
    this.fail(Failure.brokeOff(message));
  }

  // fail is the reply failing: the first failure is the one said
  fail(f: Failure.Failure) {
    this.failed ??= f;
  }

  // end is what is left once the body is read: the rest of the text, then
  // why it stopped, or the failure.
  end(): KiroEvent[] {
    if (this.ended) return [];
    this.ended = true;
    if (this.buf.length) this.broke("the connection closed partway through an event");
    const out: KiroEvent[] = this.think.end();
    if (this.failed) {
      out.push({ kind: "error", ...this.failed });
      return out;
    }
    const usage = this.usage;
    // Kiro says how full the context is rather than how many tokens
    if (!usage.input && this.pct > 0 && this.window > 0)
      usage.input = Math.floor((this.pct / 100) * this.window);
    if (!usage.output) usage.output = Math.floor((this.said + 3) / 4);
    let reason = "end_turn";
    if (this.tools > 0) reason = "tool_use";
    else if (/^max_tokens$/i.test(this.stop)) reason = "max_tokens";
    else if (/^content_filtered$/i.test(this.stop)) reason = "refusal";
    out.push({ kind: "stop", reason, usage });
    return out;
  }

  private message(headers: Record<string, string>, payload: Uint8Array, out: KiroEvent[]) {
    const type = headers[":message-type"];
    if (type === "exception" || type === "error") {
      this.failed = Failure.fromException(
        headers[":exception-type"] || headers[":error-code"],
        new TextDecoder().decode(payload)
      );
      return;
    }
    const kind = headers[":event-type"];
    if (kind && FAILURE_EVENTS.has(kind)) {
      this.failed = Failure.fromException(kind, new TextDecoder().decode(payload));
      return;
    }
    const m = Option.getOrUndefined(decodePayload(new TextDecoder().decode(payload)));
    if (!m) return;
    if (kind === "assistantResponseEvent") {
      const text = typeof m.content === "string" ? m.content : "";
      this.said += text.length;
      if (this.budget) out.push(...this.think.feed(text));
      else if (text) out.push({ kind: "text", text });
    } else if (kind === "reasoningContentEvent") {
      if (m.text) {
        this.said += m.text.length;
        out.push({ kind: "think", text: m.text });
      } else if (m.signature) out.push({ kind: "sig", text: m.signature });
    } else if (kind === "toolUseEvent") {
      if (m.toolUseId && m.toolUseId !== this.tool) {
        out.push(...this.think.end()); // the text before a call is all said
        this.tool = m.toolUseId;
        this.tools++;
        out.push({ kind: "toolStart", id: m.toolUseId, name: m.name ?? "" });
      }
      if (m.input !== undefined && m.input !== null) {
        if (typeof m.input === "string") {
          if (m.input) out.push({ kind: "toolArgs", text: m.input });
          this.said += m.input.length;
        } else {
          const s = JSON.stringify(m.input);
          if (s !== "{}") out.push({ kind: "toolArgs", text: s });
          this.said += s.length;
        }
      }
    } else if (kind === "metadataEvent" || kind === "messageMetadataEvent") {
      if (m.stopReason) this.stop = m.stopReason;
      const tu = m.tokenUsage;
      if (tu) {
        const usage = this.usage;
        usage.reported = true;
        usage.input += tu.uncachedInputTokens || tu.inputTokens || 0;
        usage.output += tu.outputTokens || 0;
        usage.cacheRead += tu.cacheReadInputTokens || 0;
        usage.cacheWrite += tu.cacheWriteInputTokens || 0;
        if (tu.contextUsagePercentage && tu.contextUsagePercentage > 0)
          this.pct = tu.contextUsagePercentage;
      }
    } else if (kind === "contextUsageEvent") {
      if (m.contextUsagePercentage && m.contextUsagePercentage > 0)
        this.pct = m.contextUsagePercentage;
    } else if (kind === "meteringEvent" && m.usage && m.usage > 0) {
      this.usage.credits += m.usage;
    }
  }
}

// events is Kiro's reply body as events. However the body ends, the last
// event says how: a stop, or an error. A body that sends nothing for
// idleSeconds, before its first event or between two, ends in a stall.
const events = (
  body: Stream.Stream<Uint8Array, unknown>,
  window: number,
  budget: number | undefined,
  idleSeconds = IDLE_SECONDS
): Stream.Stream<KiroEvent> =>
  Stream.suspend(() => {
    const reader = new ReplyDecoder(window, budget);
    return body.pipe(
      Stream.timeoutOrElse({
        duration: `${idleSeconds} seconds`,
        orElse: () => Stream.fail(new Cause.TimeoutError()),
      }),
      Stream.map((chunk) => reader.push(chunk)),
      Stream.takeUntil(() => reader.done),
      Stream.flattenIterable,
      Stream.catchCause((cause) => {
        reader.fail(Failure.fromBody(cause, idleSeconds));
        return Stream.empty;
      }),
      Stream.concat(Stream.suspend(() => Stream.fromIterable(reader.end())))
    );
  });

// anthropicUsage is the usage in Messages' words. Without counts from Kiro
// the input is reckoned from how full the context is, and the cache fields,
// unknown, are left out.
const anthropicUsage = (u: Usage) =>
  u.reported
    ? {
        input_tokens: u.input,
        output_tokens: u.output,
        cache_read_input_tokens: u.cacheRead,
        cache_creation_input_tokens: u.cacheWrite,
      }
    : { input_tokens: u.input, output_tokens: u.output };

// MessagesEncoder writes Kiro's events as Anthropic's SSE events. names
// gives back the caller's name for a tool Kiro was sent under another
// (toolNames).
class MessagesEncoder {
  private readonly id = "msg_" + randomBytes(12).toString("hex");
  private readonly enc = new TextEncoder();
  private index = -1;
  private open = ""; // the kind of block open
  private started = false;

  constructor(
    private readonly model: string,
    private readonly names: Map<string, string>
  ) {}

  encode(e: KiroEvent): Uint8Array[] {
    const out: Uint8Array[] = [];
    const sse = (type: string, data: object) =>
      out.push(this.enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
    const close = () => {
      if (this.open) sse("content_block_stop", { index: this.index });
      this.open = "";
    };
    const begin = (kind: string, block: object) => {
      close();
      this.index++;
      this.open = kind;
      sse("content_block_start", { index: this.index, content_block: block });
    };
    if (!this.started) {
      this.started = true;
      sse("message_start", {
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    const index = () => this.index;
    switch (e.kind) {
      case "text":
        if (this.open !== "text") begin("text", { type: "text", text: "" });
        sse("content_block_delta", { index: index(), delta: { type: "text_delta", text: e.text } });
        break;
      case "think":
        if (this.open !== "thinking")
          begin("thinking", { type: "thinking", thinking: "", signature: "" });
        sse("content_block_delta", {
          index: index(),
          delta: { type: "thinking_delta", thinking: e.text },
        });
        break;
      case "sig":
        if (this.open === "thinking")
          sse("content_block_delta", {
            index: index(),
            delta: { type: "signature_delta", signature: e.text },
          });
        break;
      case "toolStart":
        begin("tool", {
          type: "tool_use",
          id: e.id,
          name: this.names.get(e.name) ?? e.name,
          input: {},
        });
        break;
      case "toolArgs":
        if (this.open === "tool")
          sse("content_block_delta", {
            index: index(),
            delta: { type: "input_json_delta", partial_json: e.text },
          });
        break;
      case "error":
        close();
        sse("error", { error: Failure.toError(e) });
        break;
      case "stop":
        close();
        sse("message_delta", {
          delta: { stop_reason: e.reason, stop_sequence: null },
          usage: anthropicUsage(e.usage),
        });
        sse("message_stop", {});
        break;
    }
    return out;
  }
}

const isLast = (e: KiroEvent) => e.kind === "error" || e.kind === "stop";

// reply answers the Messages request from Kiro's events, as a stream of
// Messages events. finished is told the usage of a reply that ends well.
const reply = Effect.fnUntraced(function* (
  kiro: Stream.Stream<KiroEvent>,
  model: string,
  names: Map<string, string>,
  finished: (usage: Usage) => Effect.Effect<void>
) {
  // the first event is read before answering: an error before any of the
  // answer is a status, so OpenCode can retry it or say why. The rest of
  // the reply lives in this scope until the answer's body is read or let go.
  // Stream.peel (effect 4.0.1) drops what is left of the chunk its sink
  // ends in, so the events go one to a chunk.
  const scope = yield* Scope.make();
  const [head, rest] = yield* Stream.peel(Stream.rechunk(kiro, 1), Sink.head<KiroEvent>()).pipe(
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void))
  );
  const first = Option.getOrUndefined(head);
  if (!first || first.kind === "error") {
    yield* Scope.close(scope, Exit.void);
    return Failure.toResponse(first ?? Failure.emptyReply);
  }
  const body = Stream.concat(Stream.make(first), rest).pipe(
    Stream.takeUntil(isLast),
    Stream.tap((e) => (e.kind === "stop" ? finished(e.usage) : Effect.void)),
    Stream.mapAccum(
      () => new MessagesEncoder(model, names),
      (encoder, e) => [encoder, encoder.encode(e)] as const
    ),
    Stream.ensuring(Scope.close(scope, Exit.void))
  );
  return new Response(Stream.toReadableStream(body), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});

// ---- the plugin ------------------------------------------------------------------------

// a request that never leaves the process: what http.request sends instead
// when it can't reach Kiro, so http.response can say why
const standIn = () => new Request("data:application/json,%7B%7D", { method: "POST", body: "{}" });

// what http.response needs to turn a call's answer back, by the call
type Sent =
  | { req: MessagesRequest; model: string; thinking: Thinking; a: Auth; error?: never }
  | { error: Failure.Failure };

// Host is the part of OpenCode's plugin context this plugin uses.
type Host = {
  readonly storage: Pick<Plugin.Context["storage"], "get" | "set">;
  readonly provider: Pick<Plugin.Context["provider"], "transform" | "reload">;
  readonly session: Pick<Plugin.Context["session"], "hook">;
  readonly rpc: Pick<Plugin.Context["rpc"], "register">;
};

const make = Effect.fn("Kiro.make")(function* (ctx: Host) {
  const account = yield* KiroAccount;
  const images = yield* Images;
  const http = yield* HttpClient.HttpClient;
  // each request sent to Kiro → what turning its answer back needs
  const sent = new WeakMap<Request, Sent>();
  // the account's models: last run's until Kiro lists them
  const models = yield* Ref.make(
    Option.getOrElse(decodeSaved(yield* ctx.storage.get(MODELS_KEY)), () => FALLBACK)
  );
  const modelNamed = (id: string) =>
    Ref.get(models).pipe(Effect.map((list) => list.find((m) => m.id === id)));
  // where work outlives the request that started it: the plugin's own scope.
  // A reply's stream ends its fibers with its body.
  const scope = yield* Effect.scope;

  // the account's usage, read at most once a minute (a failure, every 10
  // seconds), and a short reason when it can't be
  const [usageCached, usageStale] = yield* Effect.cachedInvalidateWithTTL(
    account
      .credentials()
      .pipe(Effect.flatMap(readUsage), Effect.provideService(HttpClient.HttpClient, http)),
    (exit) => (Exit.isSuccess(exit) ? "60 seconds" : "10 seconds")
  );
  const accountNow = usageCached.pipe(
    Effect.map((usage): { account: AccountUsage | null; error?: string } => ({ account: usage })),
    Effect.catchCause((cause) =>
      Effect.succeed({ account: null, error: Failure.fromCause(cause).message.slice(0, 200) })
    )
  );

  // the credits each session has spent: storage's, and what was added since
  const credits = new Map<string, number>();
  const creditLock = yield* Semaphore.make(1);
  const creditsOf = Effect.fnUntraced(function* (sessionID: string) {
    const known = credits.get(sessionID);
    if (known !== undefined) return known;
    const saved = Option.getOrElse(
      decodeCredits(yield* ctx.storage.get(creditsKey(sessionID))),
      () => 0
    );
    credits.set(sessionID, saved);
    return saved;
  });
  const addCredits = (sessionID: string, n: number) =>
    creditLock.withPermits(1)(
      Effect.gen(function* () {
        const total = (yield* creditsOf(sessionID)) + n;
        credits.set(sessionID, total);
        yield* ctx.storage.set(creditsKey(sessionID), total);
      })
    );

  // without the RPC the sidebar shows nothing, and Kiro still answers
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- OpenCode's RPC API fails with unknown
  const registration = yield* ctx.rpc
    .register(KiroRpc, {
      usage: (input) =>
        Effect.gen(function* () {
          const { sessionIDs } = yield* decodeUsageInput(input).pipe(
            Effect.orElseSucceed(() => ({ sessionIDs: [] as readonly string[] }))
          );
          const spent: Record<string, number> = {};
          for (const id of sessionIDs) spent[id] = yield* creditsOf(id);
          const answer: UsageAnswer = { ...(yield* accountNow), credits: spent };
          return answer;
        }),
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kiro: registering the usage RPC failed", cause).pipe(
          Effect.as(undefined)
        )
      )
    );
  // telling the sidebar is best effort
  const emitUpdated = registration
    ? // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- OpenCode's RPC fails with unknown
      registration.events.emit("updated", {}).pipe(Effect.ignore)
    : Effect.void;

  // after a reply, the account read again and the sidebar told. One read
  // runs at a time; a reply ending during one is in what it tells.
  const refreshing = yield* Semaphore.make(1);
  const refreshUsage = usageStale.pipe(
    Effect.andThen(accountNow),
    Effect.andThen(emitUpdated),
    Effect.ignore,
    refreshing.withPermitsIfAvailable(1)
  );
  const finished = (sessionID: string | undefined) => (usage: Usage) =>
    Effect.gen(function* () {
      if (sessionID && usage.credits > 0) yield* addCredits(sessionID, usage.credits);
      yield* refreshUsage;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kiro: counting a reply's credits failed", cause)
      ),
      Effect.forkIn(scope),
      Effect.asVoid
    );

  const kiroBody = (req: MessagesRequest, model: string, profile: string, thinking: Thinking) =>
    images
      .fit(kiroRequest(req, model, profile, thinking))
      .pipe(Effect.map((b) => JSON.stringify(b)));

  // the provider is added again on each reload, with the models then known
  yield* ctx.provider.transform((editor) => {
    editor.add({ info: PROVIDER, models: Ref.getUnsafe(models).map(modelInfo) });
  });

  yield* ctx.session.hook(
    "http.request",
    Effect.fn("Kiro.request")(
      function* (event) {
        if (!new URL(event.request.url).pathname.endsWith("/messages")) return;
        // OpenCode's own Anthropic route wrote this body (see MessagesRequest)
        const req = (yield* Effect.tryPromise(() =>
          event.request.clone().json()
        )) as MessagesRequest;
        const model = String(req.model ?? "auto");
        const thinking = thinkingOf(req, model, yield* modelNamed(model));
        const a = yield* account.credentials();
        const call = yield* HttpClientRequest.toWeb(
          kiroCall(a, yield* kiroBody(req, model, a.profile, thinking))
        );
        sent.set(call, { req, model, thinking, a });
        event.request = call;
      },
      // a hook that fails fails the request with no message, so a failure
      // here goes on to http.response as a stand-in that answers with it
      (effect, event) =>
        Effect.catchCause(effect, (cause) =>
          Effect.sync(() => {
            const call = standIn();
            sent.set(call, { error: Failure.fromCause(cause) });
            event.request = call;
          })
        )
    ),
    { providerID: ID }
  );

  yield* ctx.session.hook(
    "http.response",
    Effect.fn("Kiro.response")(
      function* (event) {
        const p = sent.get(event.request);
        if (!p) return;
        sent.delete(event.request);
        if (p.error) {
          event.response = Failure.toResponse(p.error);
          return;
        }
        let res = HttpClientResponse.fromWeb(
          HttpClientRequest.fromWeb(event.request),
          event.response
        );
        // a token Kiro turned down: once more, refreshed, unless kiro-cli
        // already has
        if (res.status === 401 || res.status === 403) {
          const turnedDown = event.response;
          yield* Effect.tryPromise(() => turnedDown.body?.cancel() ?? Promise.resolve()).pipe(
            Effect.ignore
          );
          const a = yield* account.credentials(p.a.token);
          res = yield* send(
            kiroCall(a, yield* kiroBody(p.req, p.model, a.profile, p.thinking)),
            HEADERS_SECONDS
          );
        }
        if (res.status < 200 || res.status > 299) {
          const body = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
          event.response = Failure.toResponse(
            Failure.fromReply(res.status, body.slice(0, 1 << 20), res.headers)
          );
          return;
        }
        const window = (yield* modelNamed(p.model))?.context ?? 0;
        event.response = yield* reply(
          events(res.stream, window, p.thinking.budget),
          p.model,
          toolNames(p.req),
          finished(event.sessionID)
        );
      },
      (effect, event) =>
        effect.pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              event.response = cause.pipe(Failure.fromCause, Failure.toResponse);
            })
          )
        )
    ),
    { providerID: ID }
  );

  // the account's own models once Kiro lists them. A listing that fails on
  // the network or on Kiro's side is tried again 5, 20 and 80 seconds later.
  yield* Effect.gen(function* () {
    const listed = yield* listModels(yield* account.credentials());
    if (JSON.stringify(listed) === JSON.stringify(yield* Ref.get(models))) return;
    yield* Ref.set(models, listed);
    yield* ctx.storage.set(MODELS_KEY, listed);
    yield* ctx.provider.reload();
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("5 seconds", 4),
      times: 3,
      while: (e) =>
        Schema.is(Failure.RefreshError)(e) ||
        (Schema.is(Failure.KiroApiError)(e) && (e.status === 429 || e.status >= 500)),
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kiro: listing the account's models failed", cause)
    ),
    Effect.forkScoped
  );
});

// the services make runs on: the account and image fitting, over fetch
const layer = Layer.mergeAll(KiroAccount.layer, Images.layer).pipe(
  Layer.provideMerge(FetchHttpClient.layer)
);

export default {
  id: ID,
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the plugin's entry point
  effect: (ctx) => make(ctx).pipe(Effect.provide(layer)),
} satisfies Plugin.Plugin;

// for tests
export const _internal = {
  make,
  KiroAccount,
  Images,
  readCLI,
  modelOf,
  modelInfo,
  thinkingOf,
  kiroRequest,
  events,
  toolName,
  toolNames,
};
