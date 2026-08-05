# Hoodini — BUILD-PLAN

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

Each phase must leave the repo in a verifiable state: it typechecks, its tests
pass, and the thing it claims to do can be demonstrated read-only.

---

## [x] P0 — scaffold + census

- [x] Harvest RH Chain facts from sibling repos (`printer`, `tg-ca-relay`, `fork-in-hood`)
- [x] pnpm + Turborepo monorepo, TypeScript strict
- [x] `VenueAdapter` interface + `VenueRouter` stub + bundled registry shape
- [x] `SiteAdapter` interface
- [x] `scripts/recon.ts` — launchpad census, read-only
- [x] Documentation set (this file, CLAUDE.md, DECISIONS.md, ARCHITECTURE.md, DATA_SOURCES.md)
- [x] **PAUSE GATE** — all four answered: repo name is Hoodini Finance (D-015),
      venue order starts at Doppler by volume (D-018), and the terminal target
      is Axiom (confirmed 2026-08-03, see P3)

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
- [x] Searched for a Graduated/Exited asset — `scripts/doppler-states.ts`, two
      windows, ≈2,000 assets from the chain's earliest days to now. **All
      Locked.** `Initialized` is now observed; `Graduated` and `Exited` remain
      unwitnessed, so that branch of `state()` is a reading of the hook's source
      and not of the chain. Recorded in DATA_SOURCES rather than left as a to-do,
      because a negative result found deliberately is an answer
- [x] Sell control gated on a real quote of the whole balance (D-049)

## [x] P1c — Second curve adapter — **flap.sh**

- [x] Recon: the ABI's `buy`/`sell` are dead (`revert FeatureDisabled()`); the
      live path is `swapExactInput`
- [x] `claims` via `getTokenV9Safe` reverting for non-flap tokens
- [x] `state` keyed on `pool`, not the undocumented `status` enum
- [x] Quote + build both directions; buy calldata executes against live state
- [x] Plain ERC-20 approval (no Permit2 on this venue)
- [x] 21 tests, mutation-checked (5 mutations, all caught)

## [x] P1d+ — Additional launchpads

- [x] **klik.finance** — genuinely thin: derived + verified pool key, reuses the
      shared V4 encoder. 15 tests, mutation-checked (5 mutations, all caught)
- [x] Shared `v4.ts` encoder extracted; Doppler refactored onto it with its 30
      existing tests as the regression guard
- [x] **Virtuals** — recon done and adapter shipped. The trade surface is
      `BondingV5`, not the bonding adapter; found by following a real `sell`
      transaction. Priced in $VIRTUAL, which forced `Quote.quoteAsset` (D-044).
      15 tests, mutation-checked
- **NOXA needs no adapter** — launches are disabled and its tokens trade on
  Uniswap V3, already covered. (A finding, not a task; it had an unchecked box
  that could never be ticked.)
- [x] **Clanker, CashCat, Pump (V4), EthCreatorFee** — one generic
      `V4HookAdapter` plus four config entries. Pool existence proved via
      `StateView.getSlot0` with a negative control. All four verified live
- [x] 21 tests, mutation-checked (4 mutations, all caught)
- [x] **rwa-pairs** — token/token pools with bundled counterparties; the
      adapter now probes multiple pool shapes and refuses ETH-funded buys on
      pools with no ETH side (D-046)
- [x] `0x593da569…` re-examined: its key IS derivable (my earlier reason was
      wrong), but its quotes revert through the hook. Excluded on evidence,
      documented (D-047)

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
- [x] **Wired into the service worker** 2026-08-05. It never had been: the
      worker was constructed without its trade deps, so every `trade.quote` and
      `positions.list` answered UNAVAILABLE and the overlay's buttons did
      nothing. Nothing failed — the router has a legitimate "not wired up in
      this build" branch, correct while the engine was being written and then
      never revisited. Found by opening the popup and reading it in red.
      **Verified live 2026-08-05:** buttons quote on Axiom
- [x] **Rory approved the first live canary in-session** (invariant 5) — **done
      2026-08-06**, tx `0xb89c8b99d2a39570054cc48f863e9dd8344b027b0a0c1b8fa480e7493c915819`.
      0.001 ETH into YEW via the V4 UniversalRouter, success. Total leaving the
      wallet was 0.001002797723994 ETH against a gas fee of 0.000002797723994,
      so exactly 0.001000000000000 reached the swap: the 0% invariant measured
      on chain rather than asserted (D-060).
- [x] **First live sell** — **done 2026-08-06**, approve
      `0x0ef953385bd6f16ab34fdf952e87cb702bc533bf80066cdbb0cf6fe71de6e2f6` then
      swap `0x04188ffb95d1e231fd9a956c3ec7ae90f974a735f024db42e6d28b60e3362dc1`.
      The whole round trip cost 0.4993% against a compounded pool fee of
      0.4994%, so 0% holds in both directions (D-062). It also took three
      defects to get there: the sell path had never worked end to end, and a
      required-but-actually-optional field on `trade.execute` is what caused it
      (D-061).

## [~] P3 — First terminal adapter — **Axiom** (`axiom.trade`)

Confirmed by Rory 2026-08-03. Snapshot captured 2026-08-04; adapter shipped.

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
- [x] **Snapshot captured** 2026-08-04 → `docs/dom/axiom.trade.json`. Took two
      passes: v1 of the capture script gave up when it found no *full* address,
      which is exactly what every terminal does (all contracts render
      truncated). v2 falls back and reports which mode found the rows
- [x] `AxiomAdapter` — address read from `img[src]` / `a[href]`, not from the
      truncated text; **hard per-row Robinhood Chain gate** in `detectTokens`,
      not just at mount (D-050); anchored on the card by shape, which also
      sidesteps the two quick-buy buttons every card carries
- [x] Content script prefers Axiom over the generic adapter, which has no chain
      concept and would decorate BNB rows
- [x] 28 Axiom tests, mutation-checked (10 mutations; two survivors — one
      unreachable guard removed, one redundant defence given its own test)
- [x] **Verified in a browser 2026-08-04** — and it was wrong twice. Appending
      into the card's flow put the control at offset 110px in a 115px card that
      clips at 116px, so it was sliced in half; positioning it then landed it on
      the percentage badges. It now sits in the bottom-right corner on its own
      panel background (D-052)
- [x] `scripts/diagnose-overlay.js` and `scripts/diagnose-placement.js` — walk
      the detection chain and the paint path against a live page

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

## [~] P4b — GMGN + Terminal adapters

Both sites tag chain and address in one attribute, so they are one machine with
two configs rather than two adapters (D-051, following D-045).

- [x] DOM captured for both → `docs/dom/gmgn.ai.home.json`,
      `docs/dom/trade.padre.gg.json`
- [x] `ChainTaggedSiteAdapter` — locator patterns must capture *both* a chain
      slug and an address, so the D-050 gate is a property of parsing rather
      than a check that can be skipped
- [x] GMGN config: `href="/robinhood/token/0x…"`, anchored on
      `data-sentry-source-file="TokenItem.tsx"` with shape fallbacks
- [x] Terminal config: `thumbnails.padre.gg/ROBINHOOD-0x…`, anchored by shape
      (its `css-*` classes are per-build emotion hashes)
- [x] Two host permissions added; the manifest host list is asserted by exact
      equality so a new one cannot slip in unnoticed
- [x] 25 tests, mutation-checked (12 mutations; three survivors, one of which
      was a real defect — the overlay could anchor on an `<img>` and render
      nothing)
- [x] **Both seen rendering 2026-08-05.** The placement carried over correctly
      from Axiom
- [ ] GMGN's Trenches tab is uncaptured; the adapter is built from its home tab

## [x] P4c — Editable buy presets and slippage

Prompted by a question — "can we edit the amounts?" — which turned up that the
existing preset buttons were decoration: every one emitted an identical intent,
so pressing `0.01` quoted the hardcoded 0.001 (D-052).

- [x] `OverlayIntent` carries the preset that was pressed; a sell carries none,
      because a sell is always the whole balance (D-049)
- [x] `Settings` in core — pure, total on read, refusing on write (D-053)
- [x] `settings.get` page-readable so the overlay can draw its buttons;
      `settings.set` popup-only and in `NEVER_PAGE_ACCESSIBLE`, because a preset
      is a spend amount
- [x] `SettingsStore` on `chrome.storage.local`, never `sync`
- [x] Popup panel: up to four presets, slippage in basis points, errors from the
      worker rather than a second copy of the rules
- [x] Content script adopts changes live — remount rather than patch, so a
      button's label and its amount can never disagree
- [x] 58 core settings tests + 6 router tests, mutation-checked (13 mutations,
      all caught)
- [x] Seen in the popup 2026-08-05 — presets and slippage render and save

## [x] P7 — Withdraw

Prompted by the obvious question, asked before funding anything: how do the
funds come back out? They did not. Export-the-key was the only exit (D-056).

- [x] `planWithdrawal` in core — pure arithmetic, sweeps reserve the fee at the
      cap that will be signed, refuses sending exactly the balance with a
      sentence rather than a revert. 24 tests, 9 mutations, all caught
- [x] `Withdrawer` — `LIVE_TRADING` checked immediately before broadcast,
      journalled first, account re-checked inside `withKey`. 8 tests
- [x] `wallet.withdraw` popup-only and in `NEVER_PAGE_ACCESSIBLE` — the most
      direct theft the extension could expose
- [x] Popup panel: type an address, review it checksummed beside the amount,
      then send. Two presses, because a wrong address is unrecoverable
- [ ] Not yet exercised in a browser

## [x] P6 — Trade requests and the confirm sheet

The step D-026 deferred: a page proposes, extension UI approves, and
`trade.execute` never becomes page-reachable (D-054).

### [x] P6a — worker half
- [x] `PendingTrades` — one outstanding request, a second **refused** rather
      than substituted, single-use approval, two-minute expiry checked on read
- [x] `trade.request` page-allowed; `approve`/`reject`/`pending` popup-only and
      in `NEVER_PAGE_ACCESSIBLE`
- [x] Origin taken from the sender, never the message
- [x] Approval re-dispatches through `trade.execute`, so the canary ceiling,
      nonce serialisation and `LIVE_TRADING` gate are unchanged
- [x] 14 tests, mutation-checked (6 mutations, all caught)

### [x] P6b — the sheet itself
- [x] A buy click proposes instead of quoting; the button reports back
      (`confirm ↗`, or `one pending` when a request is already waiting)
- [x] `onIntent` may answer with an outcome — optional, so adapters that
      ignore it behave exactly as before
- [x] Toolbar badge while something waits. The popup cannot be opened
      programmatically from a content script, so the badge is the only honest
      signal available
- [x] Confirm sheet: origin (from the sender, unforgeable), token, amount, a
      quote fetched **at approval time**, slippage, and a plain statement that
      this build simulates rather than sends
- [x] A locked wallet no longer costs the user the request — an earlier
      version consumed it before checking, so unlocking left nothing to approve
- [x] 25 tests, mutation-checked (8 mutations; two survivors, both real gaps —
      origin spoofing and consume-on-approve had no coverage)
- [x] **Verified live 2026-08-05:** a buy click proposes, the button reads
      `confirm ↗`, and the toolbar badge appears. The badge needed an icon to
      exist at all — see P5
- [x] **Sheet and dry-run approval verified live 2026-08-05.** The trade engine
      ran in the extension for the first time: planned the trade, resolved the
      venue, built the calldata and refused at the send boundary, reporting what
      would have happened. The whole pipeline is now proven except the act of
      broadcasting

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
- [x] Icons (16/48/128) — **placeholders**, generated by
      `scripts/make-icons.mjs`. Not a branding decision: an action with no icon
      has nowhere to render a badge, so the pending-trade signal set
      successfully and showed nothing. **Rory replaces before submitting**
- [ ] **Rory:** a 1280×800 screenshot, hosted privacy URL
- [ ] **Rory:** submit to the Chrome Web Store (publishing is his call)
- [ ] **Rory:** token CA into `docs/landing/index.html` once launched
