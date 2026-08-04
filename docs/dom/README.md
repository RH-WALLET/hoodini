# DOM snapshots

Structural captures of the terminals Hoodini overlays, used to design each
`SiteAdapter` (P3/P4). Produced by `scripts/capture-dom.js`.

Terminals like Axiom sit behind Cloudflare bot protection, so they cannot be
fetched by automation — and shouldn't need to be. The extension runs *inside*
an already-authenticated browser session, so a snapshot taken from that same
session is exactly what a `SiteAdapter` will see at runtime.

One file per *view*, named for the host and — where a site's views differ
structurally — the view: `axiom.trade.json`, `gmgn.ai.home.json`,
`trade.padre.gg.json`. GMGN's home tab and Trenches tab are not the same DOM,
so a single file per host would quietly claim more coverage than exists.

**Strip anything account-specific before committing.** GMGN puts a referral
code in the URL, which the capture records verbatim; it is redacted in the
committed file.

**Before committing a snapshot, skim it.** It captures structure only — tags,
classes, `data-*` names, and two truncated sample rows — and never touches
cookies, storage, form values or authenticated API responses. But it is a
capture of your own screen, so check it.
