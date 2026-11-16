# x-blocklist

Runs the Block sync (see `GLOSSARY.md`) on gram once a day. The personal X
account ends up blocking exactly the accounts Clankwall flags as AI. Flagged
accounts get blocked, and every other blocked account gets unblocked,
including accounts you blocked by hand.

The official X API only allows blocking on the Enterprise plan, so the job
drives the logged-in Chrome through the `browse` extension instead. The
program in `src/` runs under Bun and calls `browse` CLI tools. It opens X's
blocked accounts settings page in a tab and captures the page's own
`BlockedAccountsAll` request with `browse network`. Then it calls the
endpoints the X website uses from inside that tab with `browse eval`.
browse redacts credentials in captured requests, so the in-page code
(`src/live/in-page.ts`) reads the CSRF token from the `ct0` cookie and the
web app's bearer token from its main bundle. Clankwall's
`/api/accounts?flag=ai` pages are read over plain HTTP.

A run refuses to change anything when Clankwall lists no accounts, since
syncing to an empty list would unblock everyone. It stops at a 401, 403 or
429 from X. The next run picks up whatever is left, because each run works
out the changes from both lists again.

## Dev

```sh
bun run --cwd hosts/gram/x-blocklist start --dry-run
```

A dry run reads both lists and reports `pending` changes without sending
any. It needs `browse` on `PATH` and the extension connected.

## Operating it

```sh
systemctl --user start x-blocklist     # run now
journalctl --user -u x-blocklist -n 30 # last report
```

Each block and unblock request is appended to
`~/.local/state/x-blocklist/actions.jsonl`.

A run fails with `no BlockedAccountsAll request seen, is X logged in?` when
X has logged the Chrome profile out; log in again in Chrome.
