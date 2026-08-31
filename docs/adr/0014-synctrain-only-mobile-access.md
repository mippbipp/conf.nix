# Synctrain-only mobile access for the things folder; no file server

The things folder (`~/things`) is the single filesystem source of truth synced gram ↔ pewter over Syncthing on the tailnet, with an iPhone already in the tailnet that needs to edit md and xlsx anywhere (notably the gym workout tracker offline). We extend the existing sync layer onto the phone with Synctrain (free, sushitrain, real Syncthing node, on-demand pull + optional hot set) and do not build any file server (Taildrive/SMB/WebDAV or OnlyOffice Document Server on pewter).

Taildrive would have added a second write protocol (WebDAV on 100.100.100.100:8080, `drive:share` + policy grants, Files → Tailscale) duplicating the on-demand path Synctrain already provides, introduced an alpha iOS File Provider and a dual-door staleness risk (same file via Synctrain and Taildrive), and violated filesystem-as-truth purity. SMB/WebDAV have the same duplication. An OnlyOffice Document Server on pewter would have given a single-surface web editor but costs ~1GB RAM on ARM and is unnecessary while per-format native editors (Excel/Word on phone, ONLYOFFICE Desktop Editors on gram) already open the same files through the Files provider.

Consequences: one sync protocol into the folder, offline editing via a lazily-accrued hot set (no initial hot set; `health/exercise.xlsx` is the expected first pin), iOS background-sync limitation is accepted — the app must be opened after offline edits to propagate — and staggered versioning (30d) covers stale overwrites. Taildrive remains the documented fallback if on-demand proves flaky.

Status: accepted
