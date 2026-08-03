# @hoodini/extension

The Hoodini Chrome extension: **MV3**, **Vite + CRXJS**, **React**.

**Status: placeholder (P0).** No source yet — built in **P2** (extension shell +
keystore wallet), then extended in P3/P4 with site adapters.

## Shape it will take

| Layer | Runs in | Responsibility |
|---|---|---|
| Content script | Page | One `SiteAdapter` per matched site. DOM only: detect tokens, mount buy/sell controls. No keys, no chain reads. |
| Service worker | Extension | Keystore (unlock/lock), `VenueRouter` → `VenueAdapter[]`, trade engine, all RPC. The only place a key is ever decrypted. |
| Popup / options | Extension | Wallet creation and import, unlock, settings, positions panel. |

## Constraints it is built under

These come from `CLAUDE.md` and are not negotiable at implementation time:

- Keys are generated client-side, encrypted at rest (AES-GCM, scrypt KDF), live
  only in `chrome.storage.local`, and decrypt only into service-worker memory
  with an auto-lock timer. They never leave the device.
- Strict MV3 CSP. No remote code, no `eval`, no remote config. The venue factory
  registry is bundled data updated only by cutting a release.
- Minimal host permissions: the supported sites and the RPC endpoint, nothing
  more.
- No backend. Every read goes to a public RPC or public API directly.
- `DRY_RUN=true` / `LIVE_TRADING=false` by default; the send path re-checks
  `LIVE_TRADING` at the last possible moment.
- 0% platform fee. No code path may append a fee, tip-skim, or spread.

---

## Loading it (P2b)

```bash
pnpm --filter @hoodini/extension build
```

Then `chrome://extensions` → enable Developer mode → **Load unpacked** →
select `apps/extension/dist`.

The popup can create, import, unlock, lock, export and reset a wallet. There is
no trading yet — the trade engine and the `LIVE_TRADING` gate land in P2c, and
site adapters in P3.

## The trust boundary

A content script runs in the page's world, so anything a hostile site can make
it send, it will send. Content scripts are therefore untrusted callers.

`src/background/protocol.ts` declares which surfaces may send each message and
the router enforces it centrally, so no handler has to remember the rule and
none can weaken it locally. Two independent defences:

1. `ALLOWED_SURFACES` — the policy table. Today it grants pages **nothing**.
2. `NEVER_PAGE_ACCESSIBLE` — a backstop that refuses unlock/export/create/
   import/changePassword/reset to a page *even if the table is edited wrongly*.

Both are tested independently, because a redundant defence is only worth having
if each half is proven to work on its own.

`classifySender` fails closed: a sender carrying a `tab` is a page no matter
what URL it claims, and a message from another extension is refused outright.
