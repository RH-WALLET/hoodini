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

## [x] P1c — Second curve adapter — **flap.sh**

- [x] Recon: the ABI's `buy`/`sell` are dead (`revert FeatureDisabled()`); the
      live path is `swapExactInput`
- [x] `claims` via `getTokenV9Safe` reverting for non-flap tokens
- [x] `state` keyed on `pool`, not the undocumented `status` enum
- [x] Quote + build both directions; buy calldata executes against live state
- [x] Plain ERC-20 approval (no Permit2 on this venue)
- [x] 21 tests, mutation-checked (5 mutations, all caught)

## [~] P1d+ — Additional launchpads

- [x] **klik.finance** — genuinely thin: derived + verified pool key, reuses the
      shared V4 encoder. 15 tests, mutation-checked (5 mutations, all caught)
- [x] Shared `v4.ts` encoder extracted; Doppler refactored onto it with its 30
      existing tests as the regression guard
- [x] **Virtuals** — recon done and adapter shipped. The trade surface is
      `BondingV5`, not the bonding adapter; found by following a real `sell`
      transaction. Priced in $VIRTUAL, which forced `Quote.quoteAsset` (D-044).
      15 tests, mutation-checked
- [ ] NOXA needs no adapter — launches are disabled and its tokens trade on
      Uniswap V3, already covered
- [ ] Smaller V4 hooks seen in the census (Clanker, PumpV4, CashCat, FriarTier)
      are each a thin adapter if wanted

## [x] P2 — Extension shell + keystore wallet

Split by integration layer: the keystore is pure, offline-testable and the
highest-risk code in the repo, so it lands and is verified before any UI or
send path is built on top of it.

### [x] P2a — keystore
- [x] AES-256-GCM under a scrypt-derived key (N=2^17, r=8, p=1)
- [x] create / import / unlock / export / change-password
- [x] `KeystoreSession`: key reachable only inside `withKey`, idle auto-lock
- [x] 39 tests, mutation-checked (7 mutations; one survivor found and fixed)
- [x] Executable invariant checks: no fetch/eval/storage/logging in the keystore

### [x] P2b — extension shell
- [x] MV3 + Vite + CRXJS + React; builds to a loadable unpacked extension
- [x] Strict CSP (no `unsafe-eval`, no remote origins), `storage` permission
      only, one host permission
- [x] Popup: create / import / unlock / lock / export / reset
- [x] Service-worker message boundary with a two-layer surface policy
- [x] 29 tests, mutation-checked (8 mutations; one survivor found and fixed)

### [x] P2c — trade engine
- [x] `TradePlanner` in core (send-free) + `TradeEngine` in the service worker
- [x] `LIVE_TRADING` gate immediately before `sendRawTransaction`, as a
      **build-time** constant so a shipped build cannot be talked into trading
- [x] 0.005 ETH canary ceiling, counted across every step, enforced in dry run too
- [x] Nonce read per step, all sends serialised, approve-then-swap sequencing
- [x] In-flight journal written before broadcast; never auto-resends
- [x] 47 extension tests, mutation-checked (9 mutations, all caught)
- [ ] **Rory to approve the first live canary in-session** (invariant 5)

## [ ] P3 — First terminal adapter — **Axiom** (`axiom.trade`)

Confirmed by Rory 2026-08-03. Blocked on a DOM snapshot.

Axiom is behind Cloudflare bot protection (403 `cf-mitigated: challenge`), so it
cannot be fetched by automation and defeating that is off-limits. This does not
affect the product: the content script runs inside an already-authenticated
session, so it never fetches Axiom at all. Only recon is blocked.

- [x] `scripts/capture-dom.js` — one-paste devtools capture, logic verified
      against a synthetic list in a real browser DOM
- [x] **Site-agnostic layer, complete and tested:** address detection
      (checksum-enforcing), row-finding by shape, shadow-DOM overlay,
      MutationObserver runtime with debouncing and per-row error isolation
- [x] `GenericAddressAdapter` — works on any page rendering raw addresses
      (Blockscout, DexScreener), and is the runtime's reference implementation
- [x] Content script wired: detects, mounts, and quotes via the worker
- [x] 25 adapter tests, mutation-checked (7 mutations; two survivors found,
      one of which exposed dead code)
- [ ] **BLOCKED —** Rory runs `scripts/capture-dom.js` on Axiom →
      `docs/dom/axiom.trade.json`
- [ ] `AxiomAdapter` selectors (thin layer; stub throws loudly meanwhile)
- [ ] Anchor discovery resilient to SPA re-render

## [x] P4 — X / Telegram Web / DexScreener adapters + positions panel

- [x] `ConfigurableSiteAdapter` — one machine, three ideas of a "content block"
- [x] X (`article[data-testid="tweet"]`), Telegram Web (both K and A clients),
      DexScreener (pair rows and plain tables)
- [x] Every selector falls back to shape-based anchoring, so a stale selector
      costs precision rather than the whole overlay
- [x] Content script picks the site adapter by URL, generic otherwise
- [x] Manifest lists each host explicitly — no wildcards, asserted by test
- [x] Positions panel: local balances + live sell value, from a watchlist of
      tokens the extension has actually seen
- [x] 16 site-adapter tests + 9 positions tests, mutation-checked
- [ ] **Selectors unverified against the live sites** (no DOM snapshots)

## [~] P5 — Hardening, open-source release, landing page, CWS submission

- [x] Hardening pass on the **shipped bundle**: no eval, no `new Function`, no
      analytics, no innerHTML in the page-facing script, manifest verified
      post-build — all asserted by test so they cannot regress
- [x] `pnpm audit --prod`: no known vulnerabilities
- [x] MIT LICENSE, SECURITY.md (threat model incl. what is *not* defended),
      PRIVACY.md, CONTRIBUTING.md
- [x] Landing page with token CA display — hard-coded constant, never fetched,
      refuses to render a malformed address; invariants tested
- [x] `docs/CWS-SUBMISSION.md` — permission justifications, listing copy,
      reviewer note, data-disclosure answers
- [ ] **Rory:** icons (128/48/16), a 1280×800 screenshot, hosted privacy URL
- [ ] **Rory:** submit to the Chrome Web Store (publishing is his call)
- [ ] **Rory:** token CA into `docs/landing/index.html` once launched
