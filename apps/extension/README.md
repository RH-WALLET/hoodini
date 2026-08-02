# @nock/extension

The nock Chrome extension: **MV3**, **Vite + CRXJS**, **React**.

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
