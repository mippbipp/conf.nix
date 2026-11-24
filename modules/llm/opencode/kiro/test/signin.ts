/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env, node/no-process-env, node/no-sync -- the plugin reads HOME, PATH and the sign-in files through process.env and node:fs, so the throwaway HOME is built and read with them */
// A throwaway HOME for a test file, and the sign-ins kiro-cli and the Kiro
// IDE keep, written into it as they keep them. PATH is empty so kiro-cli is
// never run. The plugin reads both on each call.

import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import { toJson } from "./json.ts";

export const PROFILE =
  "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST";

// the wall clock's time, which the sign-ins' expiries are written against
export const nowMs = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
// isoAt is an epoch ms time as kiro-cli and the IDE write it
export const isoAt = (ms: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(ms));

const Token = Schema.NullOr(Schema.Record(Schema.String, Schema.Json));
const decodeToken = Schema.decodeUnknownEffect(Schema.fromJsonString(Token));

export function throwawayHome() {
  const was = { HOME: process.env.HOME, PATH: process.env.PATH };
  const HOME = mkdtempSync(path.join(tmpdir(), "kiro-test-"));
  process.env.HOME = HOME;
  process.env.PATH = "";

  // oxlint-disable-next-line vitest/no-hooks -- the plugin reads HOME and PATH on each call, so the file's tests share them and they are put back once the file is done
  afterAll(() => {
    Object.assign(process.env, was);
    rmSync(HOME, { force: true, recursive: true });
  });
  const dbDir = path.join(HOME, ".local", "share", "kiro-cli");
  const dbPath = path.join(dbDir, "data.sqlite3");
  const ideDir = path.join(HOME, ".aws", "sso", "cache");
  const ideToken = path.join(ideDir, "kiro-auth-token.json");
  const bin = path.join(HOME, ".local", "bin");

  // kiroCli writes kiro-cli's database with these rows, in place of any before it
  function kiroCli(
    rows: Array<{
      key: string;
      table?: "auth_kv" | "state";
      value: Schema.JsonObject;
    }>
  ) {
    rmSync(dbPath, { force: true });
    mkdirSync(dbDir, { recursive: true });
    const db = new Database(dbPath, { create: true });
    db.run(
      "CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)"
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB)"
    );
    const put = (
      table: "auth_kv" | "state",
      key: string,
      value: Schema.JsonObject
    ) =>
      db
        .query(`INSERT OR REPLACE INTO ${table} (key, value) VALUES (?, ?)`)
        .run(key, toJson(value));
    for (const { key, table = "auth_kv", value } of rows) {
      put(table, key, value);
    }
    db.close();
  }

  // signIn writes a kiro-cli IAM Identity Center sign-in, as kiro-cli keeps
  // it. A null start or profile leaves it out.
  function signIn({
    access = "old",
    expires = nowMs() + 60 * 60_000,
    profile = PROFILE,
    refresh = "r1",
    region = "us-east-1",
    start = "https://example.awsapps.com/start",
  }: {
    access?: string;
    expires?: number;
    profile?: string | null;
    refresh?: string;
    region?: string;
    start?: string | null;
  } = {}) {
    const signedIn = {
      access_token: access,
      expires_at: isoAt(expires),
      refresh_token: refresh,
      region,
    };
    const scopes = { scopes: ["codewhisperer:conversations"] };
    const token: Schema.JsonObject =
      start === null || start === ""
        ? { ...signedIn, ...scopes }
        : { ...signedIn, start_url: start, ...scopes };
    kiroCli([
      { key: "kirocli:odic:token", value: token },
      {
        key: "kirocli:odic:device-registration",
        value: { client_id: "cid", client_secret: "secret" },
      },
      ...(profile !== null && profile !== ""
        ? [
            {
              key: "api.codewhisperer.profile",
              table: "state" as const,
              value: { arn: profile, profile_name: "TEST" },
            },
          ]
        : []),
    ]);
  }

  // stored is the token kiro-cli keeps under key
  const stored = (key = "kirocli:odic:token") =>
    Effect.sync(() => {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .query<{ value: string }, [string]>(
          "SELECT value FROM auth_kv WHERE key = ?"
        )
        .get(key);
      db.close();
      return row?.value ?? "null";
    }).pipe(Effect.flatMap(decodeToken));

  // signInIDE writes the Kiro IDE's token file, and the client registration
  // its clientIdHash names
  function signInIDE(
    token: Schema.JsonObject,
    registration?: Schema.JsonObject
  ) {
    mkdirSync(ideDir, { recursive: true });
    writeFileSync(ideToken, toJson(token));
    if (registration !== undefined) {
      writeFileSync(path.join(ideDir, "h.json"), toJson(registration));
    }
  }
  const storedIDE = () =>
    Effect.sync(() => readFileSync(ideToken, "utf8")).pipe(
      Effect.flatMap(decodeToken)
    );
  // whether a write-back of the IDE's token file left its temporary file
  const ideTempLeft = () => existsSync(`${ideToken}.opencode-tmp`);

  // signOut leaves neither kiro-cli nor the IDE signed in
  function signOut() {
    rmSync(dbPath, { force: true });
    rmSync(path.join(HOME, ".aws"), { force: true, recursive: true });
  }

  // readOnly makes kiro-cli's database one the plugin may read but not
  // write, or writable again
  const readOnly = (on: boolean) => chmodSync(dbPath, on ? 0o444 : 0o644);

  // installKiroCli puts a kiro-cli in ~/.local/bin, where the plugin looks
  // with PATH empty. Its `debug refresh-auth-token` writes token as
  // kiro-cli's sign-in. removeKiroCli takes it away.
  function installKiroCli(token: Schema.JsonObject) {
    mkdirSync(bin, { recursive: true });
    const script = path.join(bin, "refresh.ts");
    writeFileSync(
      script,
      `import { Database } from "bun:sqlite";
const db = new Database(${toJson(dbPath)});
db.query("INSERT OR REPLACE INTO auth_kv (key, value) VALUES (?, ?)")
  .run("kirocli:odic:token", ${toJson(toJson(token))});
db.close();
`
    );
    writeFileSync(
      path.join(bin, "kiro-cli"),
      `#!/bin/sh\nBUN_BE_BUN=1 exec ${toJson(process.execPath)} ${toJson(script)}\n`,
      { mode: 0o755 }
    );
  }
  const removeKiroCli = () => rmSync(bin, { force: true, recursive: true });

  return {
    dbPath,
    ideDir,
    ideTempLeft,
    ideToken,
    installKiroCli,
    kiroCli,
    readOnly,
    removeKiroCli,
    signIn,
    signInIDE,
    signOut,
    stored,
    storedIDE,
  };
}
