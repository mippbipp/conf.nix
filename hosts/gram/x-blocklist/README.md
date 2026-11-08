# x-blocklist

Runs the Block sync (see `GLOSSARY.md`) on gram once a day. The personal X
account ends up blocking exactly the accounts Clankwall flags as AI. Flagged
accounts get blocked, and every other blocked account gets unblocked,
including accounts you blocked by hand.

The official X API only allows blocking on the Enterprise plan, so the job
drives the logged-in Chrome through the `browse` extension instead. The
program in `src/` runs inside `browse execute`. It opens X's blocked
accounts settings page, reuses the headers of that page's own
`BlockedAccountsAll` request, and calls the endpoints the X website uses
from inside the tab. x.com's content security policy blocks requests to
other sites from that tab, so the program reads Clankwall's
`/api/accounts?flag=ai` pages in a second tab.

A run refuses to change anything when Clankwall lists no accounts, since
syncing to an empty list would unblock everyone. It stops at a 401, 403 or
429 from X. The next run picks up whatever is left, because each run works
out the changes from both lists again.

## Dev

```sh
pnpm --filter x-blocklist run build
sed 's/dryRun: false,/dryRun: true,/' dist/block.js > /tmp/opencode/dry.js
browse execute --rm --json --timeout-ms 150000 --file /tmp/opencode/dry.js
```

A dry run reads both lists and reports `pending` changes without sending
any.

## Operating it

```sh
systemctl --user start x-blocklist     # run now
journalctl --user -u x-blocklist -n 30 # last report
```

Each block and unblock request is appended to
`~/.local/state/x-blocklist/actions.jsonl`.

A run fails with `no BlockedAccountsAll request seen, is X logged in?` when
X has logged the Chrome profile out; log in again in Chrome.
