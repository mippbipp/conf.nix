// A throwaway HOME for a test file, and the sign-ins kiro-cli and the Kiro
// IDE keep, written into it as they keep them. PATH is empty so kiro-cli is
// never run. The plugin reads both on each call.

import { Database } from "bun:sqlite";
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST";

export function throwawayHome() {
  const was = { HOME: process.env.HOME, PATH: process.env.PATH };
  const HOME = mkdtempSync(join(tmpdir(), "kiro-test-"));
  process.env.HOME = HOME;
  process.env.PATH = "";
  afterAll(() => {
    Object.assign(process.env, was);
    rmSync(HOME, { recursive: true, force: true });
  });
  const dbDir = join(HOME, ".local", "share", "kiro-cli");
  const dbPath = join(dbDir, "data.sqlite3");
  const ideDir = join(HOME, ".aws", "sso", "cache");
  const ideToken = join(ideDir, "kiro-auth-token.json");

  // kiroCli writes kiro-cli's database with these rows, in place of any before it
  function kiroCli(rows: { table?: "auth_kv" | "state"; key: string; value: object }[]) {
    rmSync(dbPath, { force: true });
    mkdirSync(dbDir, { recursive: true });
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB)");
    const put = (table: "auth_kv" | "state", key: string, value: object) =>
      db
        .query(`INSERT OR REPLACE INTO ${table} (key, value) VALUES (?, ?)`)
        .run(key, JSON.stringify(value));
    for (const { table = "auth_kv", key, value } of rows) put(table, key, value);
    db.close();
  }

  // signIn writes a kiro-cli IAM Identity Center sign-in, as kiro-cli keeps
  // it. A null start or profile leaves it out.
  function signIn({
    access = "old",
    expires = Date.now() + 60 * 60_000,
    refresh = "r1",
    region = "us-east-1",
    start = "https://example.awsapps.com/start" as string | null,
    profile = PROFILE as string | null,
  } = {}) {
    kiroCli([
      {
        key: "kirocli:odic:token",
        value: {
          access_token: access,
          refresh_token: refresh,
          expires_at: new Date(expires).toISOString(),
          region,
          ...(start ? { start_url: start } : {}),
          scopes: ["codewhisperer:conversations"],
        },
      },
      {
        key: "kirocli:odic:device-registration",
        value: { client_id: "cid", client_secret: "secret" },
      },
      ...(profile
        ? [
            {
              table: "state" as const,
              key: "api.codewhisperer.profile",
              value: { arn: profile, profile_name: "TEST" },
            },
          ]
        : []),
    ]);
  }

  // stored is the token kiro-cli keeps under key
  function stored(key = "kirocli:odic:token") {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .query<{ value: string }, [string]>("SELECT value FROM auth_kv WHERE key = ?")
      .get(key);
    db.close();
    return JSON.parse(row?.value ?? "null");
  }

  // signInIDE writes the Kiro IDE's token file, and the client registration
  // its clientIdHash names
  function signInIDE(token: object, registration?: object) {
    mkdirSync(ideDir, { recursive: true });
    writeFileSync(ideToken, JSON.stringify(token));
    if (registration) writeFileSync(join(ideDir, "h.json"), JSON.stringify(registration));
  }
  const storedIDE = () => JSON.parse(readFileSync(ideToken, "utf8"));

  // signOut leaves neither kiro-cli nor the IDE signed in
  function signOut() {
    rmSync(dbPath, { force: true });
    rmSync(join(HOME, ".aws"), { recursive: true, force: true });
  }

  return { dbPath, ideDir, ideToken, kiroCli, signIn, stored, signInIDE, storedIDE, signOut };
}
