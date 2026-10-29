// The Kiro account: the sign-in kiro-cli or the Kiro IDE keeps, refreshed
// here when it is about to run out and written back for its owner, and
// Kiro's management API, called with it.

import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import {
  Array as Arr,
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  Semaphore,
  String as Str,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as Failure from "./failure.ts";
import { deadline, field, isOk, send } from "./kiro.ts";
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
  Str.toLowerCase(provider ?? "") === "builderid";

const env = (name: string) => process.env[name] ?? "";
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
// the IDE's token file is written as the IDE writes it, indented by two
const encodeIdeFile = Schema.encodeEffect(Schema.fromJsonString(JsonObject, { space: 2 }));

const parsed = <A>(decode: (text: string) => Option.Option<A>, text: string | undefined) =>
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
  for (const dir of Str.split(env("PATH"), delimiter)) {
    const path = join(dir, process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli");
    if (dir && isFile(path)) return path;
  }
  for (const path of [
    join(home(), ".local", "bin", "kiro-cli"),
    "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli",
    "/usr/local/bin/kiro-cli",
    "/opt/homebrew/bin/kiro-cli",
  ])
    if (isFile(path)) return path;
  return "";
}
function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const time = (date: string | null | undefined) =>
  date ? Option.match(DateTime.make(date), { onNone: () => 0, onSome: DateTime.toEpochMillis }) : 0;

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
    const token = parsed(decodeCliToken, text);
    if (!token?.access_token) continue;
    const cred: Cred = {
      access: token.access_token,
      refresh: token.refresh_token ?? "",
      expires: time(token.expires_at),
      region: token.region || "us-east-1",
      // an AWS sign-in's token names no profile; kiro-cli keeps the one it picked in its state
      profile: token.profile_arn || parsed(decodeCliProfile, rows.profile)?.arn || "",
      method: "social",
      dbKey: key,
    };
    if (kind === "odic") {
      cred.method = "idc";
      // kiro-cli tells Builder ID apart by its start URL, or by having none
      cred.builderID = !token.start_url || token.start_url === BUILDER_ID_START;
      const reg = parsed(decodeCliRegistration, rows.registration);
      if (reg) [cred.clientId, cred.clientSecret] = [reg.client_id ?? "", reg.client_secret ?? ""];
    } else if (kind === "external-idp") {
      cred.method = "external-idp";
      cred.clientId = token.client_id ?? "";
      cred.tokenURL =
        token.token_endpoint ||
        (token.issuer_url ? `${Str.replace(/\/$/, "")(token.issuer_url)}/v1/token` : "");
    }
    return cred;
  }
  return null;
}

// readCLI reads kiro-cli's sign-in; null when there is none it can read.
const readCLI = Effect.fnUntraced(
  function* () {
    const path = cliDB();
    if (!(yield* Effect.sync(() => existsSync(path)))) return null;
    const rows = yield* withDB(path, { readonly: true }, (db) => ({
      tokens: Arr.map(CLI_KINDS, (kind) => {
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

const readJson = <A>(path: string, decode: (text: string) => Option.Option<A>) =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap((text) => Effect.fromOption(decode(text)))
  );

// readIDE reads the Kiro IDE's sign-in; null when there is none it can read.
const readIDE = Effect.fnUntraced(
  function* () {
    const path = join(ideDir(), "kiro-auth-token.json");
    const token = yield* readJson(path, decodeIdeToken);
    if (!token.accessToken) return null;
    const cred: Cred = {
      access: token.accessToken,
      refresh: token.refreshToken ?? "",
      expires: time(token.expiresAt),
      region: token.region || "us-east-1",
      profile: token.profileArn ?? "",
      method: "idc",
      idePath: path,
      builderID: isBuilderID(token.provider),
    };
    if (token.clientIdHash) {
      const reg = yield* readJson(
        join(ideDir(), `${token.clientIdHash}.json`),
        decodeIdeRegistration
      ).pipe(Effect.option);
      if (Option.isSome(reg))
        [cred.clientId, cred.clientSecret] = [
          reg.value.clientId ?? "",
          reg.value.clientSecret ?? "",
        ];
    }
    if (Str.toLowerCase(String(token.authMethod)) === "social" || !cred.clientId)
      cred.method = "social";
    return cred;
  },
  Effect.orElseSucceed(() => null)
);

// saveBack writes a refreshed token back where it was read from, so kiro-cli
// or the IDE carries on with it (a refresh may replace the refresh token).
// from is the access token stored when the refresh began. If another is
// stored now, the user signed in again or the owner refreshed it during the
// refresh, and that newer sign-in is kept. A save that fails is let go: the
// token still works until it runs out.
const saveBack = Effect.fnUntraced(
  function* (cred: Cred, from: string) {
    const expires = DateTime.formatIso(DateTime.makeUnsafe(cred.expires));
    if (cred.dbKey) {
      const key = cred.dbKey;
      yield* withDB(cliDB(), { readwrite: true }, (db) => {
        db.run("PRAGMA busy_timeout = 3000");
        // BEGIN IMMEDIATE takes the write lock before the read, so kiro-cli
        // can't write between the check and the update
        db.transaction(() => {
          const stored = parsed(decodeJsonObject, readText(db, "auth_kv", key));
          if (!stored || stored.access_token !== from) return;
          const next = {
            ...stored,
            access_token: cred.access,
            refresh_token: cred.refresh,
            expires_at: expires,
            ...(cred.profile && cred.method === "social" ? { profile_arn: cred.profile } : {}),
          };
          db.query("UPDATE auth_kv SET value = ? WHERE key = ?").run(JSON.stringify(next), key);
        }).immediate();
      });
    } else if (cred.idePath) {
      const path = cred.idePath;
      const tmp = `${path}.opencode-tmp`;
      const stored = yield* readJson(path, decodeJsonObject);
      const text = yield* encodeIdeFile({
        ...stored,
        accessToken: cred.access,
        refreshToken: cred.refresh,
        expiresAt: expires,
      });
      yield* Effect.tryPromise(() => writeFile(tmp, text, { mode: 0o600 }));
      // The IDE takes no lock on its file, so this checks just before the
      // rename. An IDE write between the check and the rename is still lost.
      const now = yield* readJson(path, decodeJsonObject).pipe(Effect.option);
      const newer = Option.isNone(now) || now.value.accessToken !== from;
      yield* Effect.tryPromise(() => (newer ? rm(tmp, { force: true }) : rename(tmp, path)));
    }
  },
  (effect) => Effect.ignore(effect)
);

// ---- tokens --------------------------------------------------------------------

const NOT_SIGNED_IN = "Kiro isn't signed in. Run `kiro-cli login`, then try again.";
const EXPIRED = "Kiro's sign-in has expired. Run `kiro-cli login`, then try again.";
const EARLY_MS = 2 * 60 * 1000; // a token this close to its end is refreshed before a request
const fresh = (cred: Cred, now: number) => !cred.expires || cred.expires - now > EARLY_MS;

// the fields the three token endpoints answer with, in their two spellings
const TokenAnswer = Schema.Struct({
  accessToken: field(Schema.String),
  refreshToken: field(Schema.String),
  expiresIn: field(Schema.Finite),
  profileArn: field(Schema.String),
  access_token: field(Schema.String),
  refresh_token: field(Schema.String),
  expires_in: field(Schema.Finite),
});

const refreshFailed = (error: { message: string }) =>
  Failure.RefreshError.make({ message: `Couldn't refresh Kiro's sign-in: ${error.message}` });

// tokenPost asks a token endpoint for a new token. The 30 second deadline
// covers reading the answer too.
const tokenPost = Effect.fnUntraced(
  function* (request: HttpClientRequest.HttpClientRequest) {
    const res = yield* send(HttpClientRequest.acceptJson(request)).pipe(
      Effect.mapError(refreshFailed)
    );
    if ([400, 401, 403].includes(res.status))
      return yield* Failure.SignInError.make({ message: EXPIRED });
    if (!isOk(res.status))
      return yield* refreshFailed({
        message: `${new URL(request.url).host} answered HTTP ${res.status}`,
      });
    return yield* HttpClientResponse.schemaBodyJson(TokenAnswer)(res).pipe(
      Effect.mapError(refreshFailed)
    );
  },
  (effect, request) =>
    effect.pipe(
      deadline(request.url, 30),
      Effect.catchTag("TimeoutError", (error) => Effect.fail(refreshFailed(error)))
    )
);

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

// what a token endpoint answered, in one spelling
type TokenOut = { access?: string | null; refresh?: string | null; expiresIn?: number | null };

// refresh refreshes a sign-in's token the way its owner would, kiro-cli's
// by kiro-cli first. byKiroCli says kiro-cli did it. Its sign-in is then
// whatever kiro-cli keeps, which may be another account signed into meanwhile.
const refresh = Effect.fnUntraced(function* (
  cred: Cred
): Effect.fn.Return<
  { cred: Cred; byKiroCli: boolean },
  Failure.SignInError | Failure.RefreshError,
  HttpClient.HttpClient
> {
  if (cred.dbKey) {
    const bin = yield* Effect.sync(kiroExecutable);
    if (bin) {
      yield* kiroCli(bin, ["debug", "refresh-auth-token"]);
      const reread = yield* readCLI();
      const now = yield* Clock.currentTimeMillis;
      if (
        reread &&
        reread.dbKey === cred.dbKey &&
        reread.access !== cred.access &&
        fresh(reread, now)
      )
        return { cred: reread, byKiroCli: true };
    }
  }
  if (!cred.refresh) return yield* Failure.SignInError.make({ message: EXPIRED });
  let profile = cred.profile;
  let out: TokenOut;
  if (cred.method === "social") {
    const answer = yield* tokenPost(
      HttpClientRequest.post(refreshURL(cred.region)).pipe(
        HttpClientRequest.setHeader("User-Agent", DESKTOP_UA),
        HttpClientRequest.bodyJsonUnsafe({ refreshToken: cred.refresh })
      )
    );
    out = {
      access: answer.accessToken,
      refresh: answer.refreshToken,
      expiresIn: answer.expiresIn,
    };
    if (answer.profileArn) profile = answer.profileArn;
  } else if (cred.method === "idc") {
    const answer = yield* tokenPost(
      HttpClientRequest.post(`${oidc(cred.region)}/token`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          clientId: cred.clientId,
          clientSecret: cred.clientSecret,
          refreshToken: cred.refresh,
          grantType: "refresh_token",
        })
      )
    );
    out = {
      access: answer.accessToken,
      refresh: answer.refreshToken,
      expiresIn: answer.expiresIn,
    };
  } else {
    if (!cred.tokenURL) return yield* Failure.SignInError.make({ message: EXPIRED });
    const answer = yield* tokenPost(
      HttpClientRequest.post(cred.tokenURL).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "refresh_token",
          client_id: cred.clientId ?? "",
          refresh_token: cred.refresh,
        })
      )
    );
    out = {
      access: answer.access_token,
      refresh: answer.refresh_token,
      expiresIn: answer.expires_in,
    };
  }
  if (!out.access) return yield* Failure.SignInError.make({ message: EXPIRED });
  const expiresIn = out.expiresIn && out.expiresIn > 0 ? out.expiresIn : 3600;
  const now = yield* Clock.currentTimeMillis;
  const refreshed: Cred = {
    ...cred,
    profile,
    access: out.access,
    expires: now + expiresIn * 1000,
  };
  if (out.refresh) refreshed.refresh = out.refresh;
  yield* saveBack(refreshed, cred.access);
  return { cred: refreshed, byKiroCli: false };
});

// Auth is what a call to Kiro is made with.
export interface Auth {
  token: string;
  tokenType: string;
  profile: string;
  region: string;
}

// authHeaders are the headers that sign a call to Kiro.
export function authHeaders(auth: Pick<Auth, "token" | "tokenType">) {
  const Authorization = `Bearer ${auth.token}`;
  return auth.tokenType ? { Authorization, tokentype: auth.tokenType } : { Authorization };
}
const tokenType = (cred: Cred) => (cred.method === "external-idp" ? "EXTERNAL_IDP" : "");

// regionOf is where the account's API is: the region its profile is in,
// else the nearer of Kiro's two to where it signed in.
function regionOf(profile: string, signedIn: string) {
  const parts = Str.split(String(profile ?? ""), ":");
  if (parts.length > 4 && parts[3]) return parts[3];
  return Str.startsWith("eu-")(String(signedIn ?? "")) ? "eu-central-1" : "us-east-1";
}

// what a management API call sends: a query, which makes it a GET, or a
// JSON body, which makes it a POST
type ManagementInput = { query: Record<string, string> } | { body: Schema.JsonObject };

// managementCall calls Kiro's management API in auth's region. decode reads
// the answer. The 20 second deadline covers reading the answer too.
const managementCall = Effect.fnUntraced(
  function* <A>(
    decode: (json: Schema.Json) => Effect.Effect<A, Schema.SchemaError>,
    auth: Pick<Auth, "token" | "tokenType" | "region">,
    method: string,
    input: ManagementInput
  ): Effect.fn.Return<A, Failure.KiroApiError, HttpClient.HttpClient> {
    const url = `${management(auth.region)}/${method}`;
    const request = (
      "body" in input
        ? HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), input.body)
        : HttpClientRequest.setUrlParams(HttpClientRequest.get(url), input.query)
    ).pipe(HttpClientRequest.setHeaders(authHeaders(auth)), HttpClientRequest.acceptJson);
    const res = yield* send(request).pipe(Effect.mapError(unreachable(method)));
    if (!isOk(res.status))
      return yield* Failure.KiroApiError.fromReply(
        res.status,
        yield* res.text.pipe(Effect.orElseSucceed(() => ""))
      );
    return yield* res.json.pipe(
      Effect.flatMap(decode),
      Effect.mapError((error) =>
        Failure.KiroApiError.make({
          status: 502,
          body: "",
          message: `Kiro's ${method} answer didn't read as expected: ${error.message}`,
        })
      )
    );
  },
  (effect, _decode, auth, method) =>
    effect.pipe(
      deadline(management(auth.region), 20),
      Effect.catchTag("TimeoutError", (error) => Effect.fail(unreachable(method)(error)))
    )
);

const unreachable = (method: string) => (error: { message: string }) =>
  Failure.KiroApiError.make({
    status: 502,
    body: "",
    message: `Couldn't reach Kiro for ${method}: ${error.message}`,
  });

const decodeProfiles = Schema.decodeUnknownEffect(
  Schema.Struct({ profiles: field(Schema.Array(Schema.Struct({ arn: field(Schema.String) }))) })
);

// profileOf finds the profile for a sign-in that names none: Builder ID's,
// or the first Kiro lists in either of its regions.
const profileOf = Effect.fnUntraced(function* (
  cred: Cred
): Effect.fn.Return<string, Failure.KiroApiError, HttpClient.HttpClient> {
  if (cred.builderID) return BUILDER_ID_PROFILE;
  let last: Failure.KiroApiError | undefined;
  for (const region of ["us-east-1", "eu-central-1"]) {
    const out = yield* managementCall(
      decodeProfiles,
      { token: cred.access, tokenType: tokenType(cred), region },
      "List-Available-Profiles",
      { body: {} }
    ).pipe(Effect.result);
    if (Result.isSuccess(out)) {
      for (const profile of out.success.profiles ?? []) if (profile.arn) return profile.arn;
      continue;
    }
    // a Builder ID sign-in the token didn't say was one
    if (
      cred.method === "idc" &&
      out.failure.status === 403 &&
      Str.includes("Builder ID")(out.failure.body)
    )
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
const amount = field(Schema.Finite);
const when = field(Schema.Union([Schema.Finite, Schema.String])); // epoch seconds, or a date
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

const millis = (date: number | string | null | undefined) =>
  Predicate.isNumber(date) ? (date > 1e12 ? date : date * 1000) : time(date);
// "KIRO PRO" is Kiro Pro
const planName = (title: string | null | undefined) =>
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- effect/String.replaceAll takes no replacer function
  Str.toLowerCase(title || "Kiro").replaceAll(/\b\p{L}/gu, (letter) => Str.toUpperCase(letter));

type UsageLimits = Effect.Success<ReturnType<typeof decodeUsageLimits>>;
type Breakdown = typeof Breakdown.Type;

// trialOf is a breakdown's free trial, while it is active
function trialOf(breakdown: Breakdown) {
  const trial = breakdown.freeTrialInfo;
  if (!trial || trial.freeTrialStatus !== "ACTIVE") return undefined;
  const expiresAt = millis(trial.freeTrialExpiry);
  return {
    used: trial.currentUsageWithPrecision ?? trial.currentUsage ?? 0,
    limit: trial.usageLimitWithPrecision ?? trial.usageLimit ?? 0,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

// overageOf is a breakdown's overage, when overages are on (enabled) or it
// has some
function overageOf(breakdown: Breakdown, enabled: boolean) {
  const over = breakdown.currentOveragesWithPrecision ?? breakdown.currentOverages ?? 0;
  if (!enabled && !(over > 0) && !breakdown.overageCharges) return undefined;
  return {
    credits: over,
    charges: breakdown.overageCharges ?? 0,
    currency: breakdown.currency || "USD",
    rate: breakdown.overageRate ?? 0,
    cap: breakdown.overageCapWithPrecision ?? breakdown.overageCap ?? 0,
    enabled,
  };
}

// allowanceOf is a breakdown as the sidebar shows it, or undefined for one
// with no limit. enabled is whether the account has overages turned on.
function allowanceOf(breakdown: Breakdown, enabled: boolean): Allowance | undefined {
  const trial = trialOf(breakdown);
  const limit = breakdown.usageLimitWithPrecision ?? breakdown.usageLimit ?? 0;
  if (!limit && !trial?.limit) return undefined;
  const overage = overageOf(breakdown, enabled);
  return {
    name:
      breakdown.displayNamePlural || breakdown.displayName || breakdown.resourceType || "Credits",
    used: breakdown.currentUsageWithPrecision ?? breakdown.currentUsage ?? 0,
    limit,
    ...(overage ? { overage } : {}),
    ...(trial ? { trial } : {}),
  };
}

function accountUsage(limits: UsageLimits, checkedAt: number): AccountUsage {
  const enabled = limits.overageConfiguration?.overageStatus === "ENABLED";
  const allowances: Allowance[] = [];
  let resetsAt = millis(limits.nextDateReset);
  for (const breakdown of limits.usageBreakdownList ?? []) {
    if (!breakdown) continue;
    const allowance = allowanceOf(breakdown, enabled);
    if (!allowance) continue;
    allowances.push(allowance);
    resetsAt ||= millis(breakdown.nextDateReset);
  }
  return {
    plan: planName(limits.subscriptionInfo?.subscriptionTitle),
    resetsAt,
    allowances,
    checkedAt,
  };
}

// readUsage reads the account's usage from Kiro
const readUsage = Effect.fnUntraced(function* (auth: Auth) {
  const limits = yield* managementCall(decodeUsageLimits, auth, "Get-Usage-Limits", {
    query: { origin: "KIRO_CLI", profileArn: auth.profile, resourceType: "CREDIT" },
  });
  return accountUsage(limits, yield* Clock.currentTimeMillis);
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
const listModels = Effect.fnUntraced(function* (auth: Auth) {
  const list: KiroModel[] = [];
  let defaultModel: string | undefined;
  let next: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = yield* managementCall(decodeModelsPage, auth, "List-Available-Models", {
      query: {
        origin: "KIRO_CLI",
        profileArn: auth.profile,
        ...(next ? { nextToken: next } : {}),
      },
    });
    defaultModel ??= page.defaultModel?.modelId ?? undefined;
    for (const model of page.models ?? []) {
      const listed = decodeListedModel(model);
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
  const i = Option.getOrElse(
    Arr.findFirstIndex(list, (model) => model.id === defaultModel),
    () => 0
  );
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
      const refreshedFrom = new Map<string, Cred>();
      // The profile Kiro listed for the sign-in at each location, with that
      // sign-in's refresh token. The access token changes every hour, so the
      // refresh token tells one account from another signed in at the same
      // place. A refresh of ours that replaces it carries the profile over.
      // One by kiro-cli doesn't: what it keeps after may be another account
      // signed into meanwhile, so it is matched by its own refresh token.
      // If kiro-cli replaced that for the same account, its profile is
      // listed once more.
      const profiles = new Map<string | undefined, { refresh: string; profile: string }>();

      const credentials = Effect.fn("KiroAccount.credentials")(
        function* (rejected?: string) {
          let cred = (yield* readCLI()) ?? (yield* readIDE());
          if (!cred) return yield* Failure.SignInError.make({ message: NOT_SIGNED_IN });
          for (let i = 0; i < 16; i++) {
            const newer = refreshedFrom.get(cred.access);
            if (!newer) break;
            cred = newer;
          }
          // the refresh token a profile kept for this sign-in was listed under
          let listedUnder = cred.refresh;
          if (!fresh(cred, yield* Clock.currentTimeMillis) || cred.access === rejected) {
            const out = yield* refresh(cred);
            refreshedFrom.set(cred.access, out.cred);
            const [oldest] = refreshedFrom.keys();
            if (refreshedFrom.size > 16 && oldest !== undefined) refreshedFrom.delete(oldest);
            cred = out.cred;
            if (out.byKiroCli) listedUnder = cred.refresh;
          }
          const source = cred.dbKey ?? cred.idePath;
          const known = profiles.get(source);
          if (!cred.profile)
            cred.profile = known?.refresh === listedUnder ? known.profile : yield* profileOf(cred);
          profiles.set(source, { refresh: cred.refresh, profile: cred.profile });
          return {
            token: cred.access,
            tokenType: tokenType(cred),
            profile: cred.profile,
            region: regionOf(cred.profile, cred.region),
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
