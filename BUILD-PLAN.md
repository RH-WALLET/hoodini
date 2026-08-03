# Hoodini — BUILD-PLAN

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

Each phase must leave the repo in a verifiable state: it typechecks, its tests
pass, and the thing it claims to do can be demonstrated read-only.

---

## [~] P0 — scaffold + census

- [x] Harvest RH Chain facts from sibling repos (`printer`, `tg-ca-relay`, `fork-in-hood`)
- [x] pnpm + Turborepo monorepo, TypeScript strict
- [x] `VenueAdapter` interface + `VenueRouter` stub + bundled registry shape
- [x] `SiteAdapter` interface
- [x] `scripts/recon.ts` — launchpad census, read-only
- [x] Documentation set (this file, CLAUDE.md, DECISIONS.md, ARCHITECTURE.md, DATA_SOURCES.md)
- [ ] **PAUSE GATE** — Rory confirms terminal target, launchpad priority, repo name, venue order

## [x] P1a — VenueAdapter finalization + VenueRouter + Uniswap adapter + harness

Graduated tokens become tradeable first, because that path works for every
launchpad's graduates at once.

- [x] `VenueAdapter` finalised — signature unchanged from P0; the router's
      MSG_SENDER sentinel removed the need for an `owner` param on `build*`
- [x] `VenueRouter.resolve()` — override → registry attribution → `claims()`
- [x] Uniswap V3 adapter: `QuoterV2` quotes, `SwapRouter02` builds
- [x] `apps/harness` CLI: resolve, quote both ways, print + simulate calldata
- [x] Slippage and deadline handling, exact-in only
- [x] Test suite — vitest, 38 tests, offline against a stub client. Mutation-
      checked: rounding, recipient, fee-ABI and zero-amount guards each turn
      the suite red when broken.

**Census note:** this single adapter covers the Pons corpus outright — Pons
tokens are Uniswap V3 pools from block one, not curves. See DECISIONS.md D-007.

## [~] P1b — First curve adapter — **Doppler** (Uniswap V4)

Chosen by volume: 173 of 660 recent V4 pools (26%), the largest V4 launch venue.
Split by integration layer per CLAUDE.md, since the read and write paths have
independent risk.

### [x] P1b-1 — read path
- [x] `claims()` / `state()` via the hook's `getState` + `PoolStatus` enum
- [x] `quoteBuy` / `quoteSell` via the bound V4Quoter
- [x] Registry entry, harness support, 18 tests (mutation-checked)

### [x] P1b-2 — write path
- [x] UniversalRouter `execute(commands, inputs)` V4_SWAP encoding, read from
      the deployed source (a forked router exists, so upstream constants are
      not safe here)
- [x] Permit2 two-step approval flow, with expiry handling
- [x] Both paths executed against live state via `eth_call` + state overrides
- [x] 30 Doppler tests, mutation-checked (5 mutations, all caught)
- [ ] Confirm a Graduated/Exited asset on-chain — none observed yet
- [ ] Surface "sell unavailable" in the UI for pools whose sell side reverts

## [ ] P1c — Second curve adapter

## [ ] P1d+ — Additional launchpads, one thin adapter spec each (Sonnet-eligible)

## [ ] P2 — Extension shell + keystore wallet

- [ ] MV3 + Vite + CRXJS + React shell, strict CSP
- [ ] Keystore: create / import / unlock / lock / export, AES-GCM + scrypt
- [ ] Service-worker trade engine wired to `VenueRouter`
- [ ] `LIVE_TRADING` gate at the send boundary; canary ≤ 0.005 ETH on approval

## [ ] P3 — First terminal adapter — **Axiom** (`axiom.trade`)

Confirmed by Rory 2026-08-03. Blocked on a DOM snapshot.

Axiom is behind Cloudflare bot protection (403 `cf-mitigated: challenge`), so it
cannot be fetched by automation and defeating that is off-limits. This does not
affect the product: the content script runs inside an already-authenticated
session, so it never fetches Axiom at all. Only recon is blocked.

- [x] `scripts/capture-dom.js` — one-paste devtools capture, logic verified
      against a synthetic list in a real browser DOM
- [ ] Rory runs it on Axiom → `docs/dom/axiom.trade.json`
- [ ] `SiteAdapter` for Axiom
- [ ] Anchor discovery resilient to SPA re-render

## [ ] P4 — X / Telegram Web / DexScreener adapters + positions panel

## [ ] P5 — Hardening, open-source release, landing page with token CA display, CWS submission
