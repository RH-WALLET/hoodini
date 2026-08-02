# DOM snapshots

Structural captures of the terminals Hoodini overlays, used to design each
`SiteAdapter` (P3/P4). Produced by `scripts/capture-dom.js`.

Terminals like Axiom sit behind Cloudflare bot protection, so they cannot be
fetched by automation — and shouldn't need to be. The extension runs *inside*
an already-authenticated browser session, so a snapshot taken from that same
session is exactly what a `SiteAdapter` will see at runtime.

One file per site, named for the host: `axiom.trade.json`, `gmgn.ai.json`, …

**Before committing a snapshot, skim it.** It captures structure only — tags,
classes, `data-*` names, and two truncated sample rows — and never touches
cookies, storage, form values or authenticated API responses. But it is a
capture of your own screen, so check it.
