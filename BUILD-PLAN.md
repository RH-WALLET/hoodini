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
- [ ] Unit tests for the money math (`applySlippage`) — no test runner in the
      repo yet; carried into P1b rather than bolted on here

**Census note:** this single adapter covers the Pons corpus outright — Pons
tokens are Uniswap V3 pools from block one, not curves. See DECISIONS.md D-007.

## [ ] P1b — First curve adapter

Launchpad chosen from the census by volume, pending Rory's ranking at the gate.

- [ ] Curve buy/sell + quote path
- [ ] `state()` curve-vs-graduated detection and the handover to the DEX path
- [ ] Harness coverage for both sides of graduation

## [ ] P1c — Second curve adapter

## [ ] P1d+ — Additional launchpads, one thin adapter spec each (Sonnet-eligible)

## [ ] P2 — Extension shell + keystore wallet

- [ ] MV3 + Vite + CRXJS + React shell, strict CSP
- [ ] Keystore: create / import / unlock / lock / export, AES-GCM + scrypt
- [ ] Service-worker trade engine wired to `VenueRouter`
- [ ] `LIVE_TRADING` gate at the send boundary; canary ≤ 0.005 ETH on approval

## [ ] P3 — First terminal adapter — **Axiom** (`axiom.trade`)

Confirmed by Rory 2026-08-03. Blocked on a DOM snapshot.

- [ ] `SiteAdapter` for Axiom
- [ ] Anchor discovery resilient to SPA re-render

## [ ] P4 — X / Telegram Web / DexScreener adapters + positions panel

## [ ] P5 — Hardening, open-source release, landing page with token CA display, CWS submission
