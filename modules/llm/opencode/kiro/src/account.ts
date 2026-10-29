// The Kiro account: the sign-in kiro-cli or the Kiro IDE keeps, refreshed
// here when it is about to run out and written back for its owner, and
// Kiro's management API, called with it.

import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { Clock, Context, DateTime, Effect, Layer, Option, Result, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as Failure from "./failure.ts";
import { field, send } from "./kiro.ts";
import { decodeListedModel, type KiroModel, modelOf } from "./models.ts";
import type { AccountUsage, Allowance } from "./rpc.ts";

const oidc = (region: string) => `https://oidc.${region}.amazonaws.com`;
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
export interface Auth {
  token: string;
  tokenType: string;
  profile: string;
  region: string;
}

// authHeaders are the headers that sign a call to Kiro.
export function authHeaders(a: Pick<Auth, "token" | "tokenType">) {
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

// ---- models ----------------------------------------------------------------------

// a page of List-Available-Models; each model is read on its own, so one
// Kiro lists in a shape this doesn't know leaves the rest
const decodeModelsPage = Schema.decodeUnknownEffect(
  Schema.Struct({
    models: field(Schema.Array(Schema.Unknown)),
    defaultModel: field(Schema.Struct({ modelId: field(Schema.String) })),
    nextToken: field(Schema.String),
  })
);

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

// ---- the account ---------------------------------------------------------------

type AccountError = Failure.SignInError | Failure.RefreshError | Failure.KiroApiError;

// KiroAccount hands out the credentials to call Kiro with, read fresh from
// kiro-cli (or the IDE) each time and refreshed when near their end or
// turned down. One refresh runs at a time, since a refresh may replace the
// refresh token. It also asks Kiro's management API about the account,
// with those credentials.
export class KiroAccount extends Context.Service<
  KiroAccount,
  {
    // rejected is a token Kiro turned down: refreshed, unless its owner has already
    readonly credentials: (rejected?: string) => Effect.Effect<Auth, AccountError>;
    // the account's usage this month (Get-Usage-Limits)
    readonly usage: Effect.Effect<AccountUsage, AccountError>;
    // the models Kiro lists for the account, its default first (List-Available-Models)
    readonly models: Effect.Effect<readonly KiroModel[], AccountError>;
  }
>()("opencode-kiro/account/KiroAccount") {
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

      const usage = credentials().pipe(
        Effect.flatMap(readUsage),
        Effect.provideService(HttpClient.HttpClient, http)
      );
      const models = credentials().pipe(
        Effect.flatMap(listModels),
        Effect.provideService(HttpClient.HttpClient, http)
      );

      return KiroAccount.of({ credentials, usage, models });
    })
  );
}
