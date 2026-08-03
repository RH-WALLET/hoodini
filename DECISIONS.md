# Hoodini — DECISIONS

Append-only log. Each entry: what was decided, why, and what would reverse it.
Decisions marked **PENDING RORY** are proposals only and must not be built on.

---

### D-001 — pnpm + Turborepo monorepo, TypeScript strict everywhere
**Decided.** `apps/extension`, `apps/harness`, `packages/core`, `packages/adapters`.

The extension and a Node harness must share the exact trade-path code — if the
harness tested a reimplementation, its green result would prove nothing about
what the extension ships. A workspace makes `@hoodini/core` one artifact consumed
by both. Matches the layout already used in `~/Projects/trenches`.

Strict mode plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`:
this codebase manipulates `bigint` wei amounts and addresses, where a silently
`undefined` field is a wrong-amount bug, not a crash.

*Reversed by:* the extension bundler proving unable to consume workspace TS
sources directly (would move `@hoodini/core` to a built `dist`).

---

### D-002 — No backend in v1
**Decided.** All reads go from the extension straight to public RPC and public
explorer APIs.

A backend is the thing competitors have and we are underselling. It is also a
key-exfiltration surface, a censorship point, an outage, and a reason users must
trust us. "No server exists" is a stronger claim than "our server is honest,"
and it is auditable from the manifest's host permissions.

*Cost accepted:* no server-side mempool edge, no cross-device sync, rate limits
are the public RPC's.

*Reversed by:* nothing in v1. A later optional relay would be opt-in and must
never see a key.

---

### D-003 — Local keystore: AES-GCM + scrypt, `chrome.storage.local`, memory-only unlock
**Decided.** Keys are generated in-extension, encrypted at rest, decrypted only
into service-worker memory, auto-locked on a timer.

scrypt over PBKDF2 for memory-hardness against offline attack on a stolen
profile directory. AES-GCM for authenticated encryption — a tampered blob must
fail to decrypt rather than yield garbage that gets signed with.

The plaintext key must never touch `chrome.storage`, `localStorage`, a content
script, or a log line. Content scripts run in a page's world and are treated as
hostile: they may request a trade, never a signature.

*Reversed by:* a hardware-wallet path (additive, would not remove this).

---

### D-004 — `DRY_RUN=true` / `LIVE_TRADING=false` defaults, checked at the send boundary
**Decided.** Both flags default safe. The `LIVE_TRADING` check happens at the
last possible moment before broadcast — not at startup, not at config load.

An early check can be invalidated by anything that happens between it and the
send. Checking at the boundary means the only way to broadcast is to pass the
gate on that specific call. First live trade is a single canary ≤ 0.005 ETH with
Rory's explicit in-session approval.

P0 has no send path at all: `scripts/recon.ts` has no signer and imports nothing
that can sign.

---

### D-005 — `VenueAdapter` + `VenueRouter`, resolving through a **bundled** registry
**Decided.** Every venue implements one interface. A router maps a contract
address to the adapter that can trade it, using bundled registry data first and
a runtime `claims()` probe as fallback.

The registry is shipped inside the extension and changed only by cutting a
release. It is deliberately **not** remote config: the registry decides which
contract a buy is sent to, so a compromised remote registry would be a
one-request theft of every user's next trade. Shipping it in the bundle puts
that mapping in a reviewable diff and inside the CWS review process.

`claims()` is the fallback for tokens too new to be in the bundle, and is
specified as a single cheap on-chain read — never an unbounded log scan — so an
unknown token costs one call per registered venue, not a scan.

---

### D-006 — v1 venue priority order — **PENDING RORY**
**Proposed from census volume data (2026-08-02). Not approved. Do not build on.**

1. **Uniswap V3** — not a launchpad, but the settlement venue for the entire
   Pons/NOXA corpus. One adapter, and 72 of 74 sampled tokens become tradeable.
2. **Pons** — 72/74 sampled tokens, `launchEnabled=true`, verified source,
   non-upgradeable. Its tokens *are* V3 pools, so #1 largely delivers it; the
   Pons-specific work is `claims()` attribution and metadata.
3. **flap.sh** — the one confirmed genuine bonding curve, with `buy`/`sell` on
   the Portal. This is where curve-adapter design work actually happens.
4. **Virtuals** — 2/74 sampled, bonding curve via `VirtualsBondingAdapter`,
   settles into Uniswap V4.
5. **klik.finance** — live and permissionless, Uniswap V4 + hooks, but zero
   presence in the sampled corpus.
6. **NOXA** — new launches still disabled (`launchEnabled=false`, unchanged
   since 2026-07-11). Old tokens trade on V3, so #1 covers them. No new work.

Rory ranks these at the pause gate; the approved order lands here as D-006-final.

---

### D-007 — Census finding: Pons **V1** is an instant-pool venue, not a bonding curve
**Recorded fact, drives sequencing. AMENDED 2026-08-02 — see D-011: Pons V2 changes this.**

`PonsLaunchFactory` exposes no buy/sell functions at all. Its tokens carry
`liquidityPool()`, `pairToken()`, `poolFee()` and are Uniswap V3 pools paired
against WETH at a 1% fee from the moment of launch. There is no curve to trade
against and no graduation event to wait for.

Consequence: the P1a Uniswap adapter is not merely "graduated tokens first" — it
is the whole trade path for the dominant venue. `state()` returns `graduated`
for Pons tokens immediately. Genuine curve work starts at flap.sh (P1b).

This also means the brief's assumption that curve adapters are the bulk of the
work does not hold for RH Chain as it exists today.

---

### D-008 — `claims()` for Pons reads the token, not the factory
**Decided.** `token.launchFactory() == PONS_FACTORY`.

One static call on the token itself. Cheaper than a factory mapping read, needs
no factory state, and returns the attribution directly. Verified live:
`0xc6a672…c82b.launchFactory()` → `0xA5aAb3…1feB`.

Adapters should prefer a token-side getter over a factory-side mapping wherever
one exists, for the same reason.

---

### D-009 — Router for the Uniswap V3 path — **RESOLVED 2026-08-02**
**Decided:** `SwapRouter02` **`0xCaf681a66D020601342297493863E78C959E5cb2`**.

Multiple `SwapRouter02`, `QuoterV2` and `UniversalRouter` contracts exist on this
chain and name is not evidence — several bind to *different* V3 factories. Rule:
a router or quoter is usable only once its `factory()` is confirmed equal to the
pool's factory.

This one passes on both counts — `factory()` → `0x1f7d7550…` (canonical V3
factory) **and** `WETH9()` → `0x0Bd7D308…` (canonical WETH) — and it is what the
Pons operator itself routes real `multicall` trades through. Paired with
`QuoterV2` `0x238ECf69…`, which binds to the same factory.

The two `UniversalRouter` deployments seen carrying trades expose no `factory()`,
so they cannot be validated this way and are not used in v1.

---

### D-010 — VERIFIED vs UNCONFIRMED, and what may be traded against
**Decided.** Every address in DATA_SOURCES.md carries a status. Only **VERIFIED**
entries — confirmed on-chain by `scripts/recon.ts` this session — may ever be
used to build a transaction. UNCONFIRMED entries are leads.

Harvested notes are treated as untrusted input and re-derived on chain. This
caught a real drift: flap.sh's Portal implementation is now
`0x7Bc20c2C…`, not the `0xd9C9981D…` recorded three weeks ago. An adapter that
had trusted the note would be encoding against a replaced implementation.

---

### D-011 — Pons V2 exists, has a real bonding curve, and is the #1 venue — **PARTIALLY BLOCKED**
**Amends D-006 and D-007.** Raised by Rory 2026-08-02; corroborated by public
reporting, **not yet verified on-chain**.

Pons V2 shipped an **ETH-denominated bonding curve** and **Uniswap V4**
integration, plus RWA trading pairs (USDG, NVDA, AAPL, HOOD) and creator payouts
in ETH. Pons reportedly drives ~80% of RH Chain launchpad volume and more than
half of all transactions on the chain.

This overturns the sequencing in D-007. The census measured the **V1** factory
`0xA5aAb3F0…`, which genuinely has no curve — every seed token traced to it is a
Uniswap V3 pool from launch. But V1 is not where new volume is going. V2 is a
curve venue, so the first curve adapter should be Pons V2, not flap.sh.

**Blocked:** the V2 factory address could not be established on-chain.
- Every recent `PonsLauncherToken` still traces to the V1 factory.
- The V1 factory owner (`0xda4bCee7…`) has no contract creations in its recent
  history.
- Explorer name search returns only copycat memecoins called "Pons"/"PonsV2".
- `pons.family` and `docs.pons.family` do not resolve from this environment.

**Needed from Rory:** the V2 factory address, or the live site/docs URL. One
`pnpm recon` run verifies it and fills in the curve interface, `claims()` read,
and the V4 quote path.

---

### D-012 — The old working name "nock" collided with a live competitor — **RESOLVED by D-015**
**Raised 2026-08-02. Superseded 2026-08-03 by the rename to Hoodini Finance.**

The original working name for this project was **nock**. **Nock Terminal**
(`nockterminal.com`) is an existing, live Robinhood Chain token screener and
trading-tool suite, with a Telegram trading bot (**NockBot**, which discloses a
**1% platform fee**), a wallet tracker, and its own launchpad.

Same chain, same category, near-identical name, and its headline number was the
exact fee we undercut to zero. Keeping it would have meant competing against a
product users already called "Nock", having our 0% claim read against a 1%
product under the same name, avoidable trademark exposure at CWS submission
(P5), and worsening SEO/support confusion.

Kept as a record of why the name changed, and as the reason every candidate name
now gets a collision check before adoption.

---

### D-011-update — Pons V2 not found on-chain; D-011's sequencing change is suspended
**2026-08-02, after four independent searches.**

D-011 proposed moving the first curve adapter to Pons V2. That is suspended:
V2's contracts cannot be found on-chain. Explorer name search, a 59-contract
factory-interface sweep, a 400-block traffic ranking, and a 1,711-pool Uniswap V4
hook census all came back negative (detail in DATA_SOURCES.md §7).

Two corrections to the earlier record fall out of it:

**The Pons "instant pool vs curve" framing was too binary.** The factory's own
`getLaunchConfig(0)` declares a **4.2 ETH graduation threshold**. Pons implements
its curve as a single-sided concentrated Uniswap V3 position, not a separate
curve contract. So D-007's conclusion holds where it matters — **buy/sell is a V3
swap before *and* after graduation, so one adapter covers both** — but "no
graduation exists" was wrong. `state()` should report curve vs graduated from
`graduationStatus(token)`, even though the trade path does not branch on it.

**D-009 is confirmed by the protocol, not just by observation.** Pons's
`getDexConfig(0)` names `swapRouter = 0xCaf681a66D020601342297493863E78C959E5cb2`
directly. That is the router the launchpad itself designates.

---

### D-013 — One adapter covers the whole Pons family (9 factories)
**Decided.** `claims()` is a set-membership test:
`token.launchFactory() ∈ {9 known Pons-interface factories}`.

The interface has been cloned repeatedly by fee-undercutting forks. All nine
declare an identical DEX config — same V3 factory, same `SwapRouter02`, same
fee tier — so they are one adapter and one registry entry with a set of
factories, not nine adapters.

The bundled registry ships the set; `claims()` still works for a clone deployed
after our last release, because the *token* names its own factory and the
membership test is data, not code. A tenth clone is a data-only update.

---

### D-014 — Doppler is a census gap and probably belongs in v1 — **PENDING RORY**
Uniswap V4 hook enumeration surfaced `DopplerHookInitializer`
`0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` with **324 pools initialized in
~5.5 hours** — by far the largest V4 launch venue on RH Chain, and completely
absent from the original seed corpus (which predates it or simply never saw it).

Also live on V4: `PumpV4Hook`, `ClankerHookStaticFeeV2`, `UniversalKlikHook`
(confirming klik), `LaunchHook`, `FriarTier`.

This is exactly the failure mode the seed corpus was always going to have — it
was scraped 2026-07-20…23 and cannot show venues that grew since. Recommend
Doppler enters the v1 ranking above flap.sh, pending Rory's volume call.

---

### D-015 — Product name is **Hoodini Finance**; GitHub profile is `RH-WALLET`
**Decided by Rory 2026-08-03.** Supersedes D-012.

- **Product / packages / repo:** `Hoodini` (`hoodini`, `@hoodini/*`)
- **GitHub profile:** `RH-WALLET` (user account, created 2026-08-02)

Collision-checked before adoption, per the lesson in D-012: no RH Chain product,
terminal, wallet or extension named Hoodini was found. The only near match is
"Hood Inu", an unrelated memecoin — different category, no confusion risk.

**Why the product is not called RH-WALLET.** "RH" reads as Robinhood. A
non-affiliated extension that custodies private keys and is named `RH-WALLET`
implies Robinhood Markets, Inc. stands behind those keys. That is an
implied-affiliation problem rather than a competitor-confusion one, and it lands
in the highest-scrutiny Chrome Web Store category (a key-holding wallet using
another brand's identity). Note that Nock Terminal ships an explicit "not
affiliated with Robinhood Markets, Inc." disclaimer — evidence of how the market
reads RH-prefixed naming. Rory scoped `RH-WALLET` to the GitHub handle only,
which carries none of that risk.

**Carry-forward for P5:** the landing page and the CWS listing must both state
that Hoodini Finance is not affiliated with Robinhood Markets, Inc. "Hoodini"
is a play on Houdini, but it sits on Robinhood Chain and the disclaimer is
cheap insurance.

---

### D-016 — `state()` for Pons reads `graduationStatus`; one adapter covers both states
**Decided 2026-08-03, proven against a graduated token.**

`graduationStatus(address)` returns `(raised, threshold, graduated)` in one
static call. That is the `state()` implementation: `graduated ? 'graduated' :
'curve'`.

The important part is what it does *not* change. Kolana
(`0xB84e4941…`, 5.32 ETH raised vs a 4.2 ETH threshold, graduated) quotes
through the same `QuoterV2` and the same Uniswap V3 pool as a pre-graduation
Pons token. **Graduation relocates the liquidity position; it does not relocate
the venue.** So `state()` is display information and does not branch the trade
path.

This closes the loop on D-007 and D-011-update, which reached the same
conclusion from the factory's config alone. It is now verified against a real
graduated token rather than inferred.

*Reversed by:* a Pons version where graduation migrates liquidity to a different
DEX. Pons V1's `getDexConfig` has exactly one entry (`uniswap v3`), so this
cannot happen without a new factory — which is precisely what a real Pons V2
would be.

---

### D-016-amendment — `graduated` is reversible; `state()` is display-only
**2026-08-03, found while verifying the P1a adapter against the live chain.**

D-016 recorded `graduationStatus` as `(raised, threshold, graduated)` and made it
the `state()` implementation. That stands, but one property was wrong by
omission: **`graduated` is not a latched event.**

`raised` is the pool's live WETH reserve. Kolana read
`(5.32 ETH, 4.2 ETH, true)` when first checked and `(0.0055 ETH, 4.2 ETH,
false)` hours later — corroborated against the pool, which by then held
0.005508 ETH and 995,956,029 of the 1,000,000,000 supply. Holders sold back;
the flag followed the reserve down.

Rules that follow:

1. **Never cache `state()`.** It is a live read, valid only at the block it was
   taken.
2. **Never let `state()` gate anything irreversible** — no approval decision, no
   send decision, nothing a user cannot undo.
3. Present it as an indicator, never as a guarantee about a token's stage.

**This is why the trade path deliberately does not branch on `state()`.** The
same pool, router and quoter serve both readings, so a flag that oscillates
cannot produce a wrong trade — it can only produce a stale label. Had the design
branched on state, this would have been a live bug instead of a docs
correction.

It also clarifies what Pons "graduation" is: a liquidity-depth threshold on a
single-sided V3 position, not a migration between venues.

---

### D-017 — Tests are offline and mutation-checked
**Decided 2026-08-03.** vitest, unit tests only, run against a stub client.

**Offline by rule.** A suite that read live pool state would have gone red on
its own when Kolana's reserve fell from 5.32 ETH to 0.0055 ETH overnight
(D-016-amendment) — a failure caused by the market, not by our code. Chain
reality is the harness's job; the suite exists to pin encoding and invariants,
so it never touches the network.

**Assertions decode, they do not snapshot.** Calldata tests decode the multicall
and assert on the fields. A hex snapshot would pass while encoding something
entirely different, which is the failure mode that matters here.

**The suite is verified by breaking things.** Four deliberate mutations were
applied and each turned it red:

| Mutation | Caught by |
|---|---|
| `applySlippage` rounds up instead of down | 2 tests |
| Buy pays a hardcoded address instead of `MSG_SENDER` | 1 test |
| `unwrapWETH9WithFee` added back to the router ABI | 2 tests |
| Zero-amount guard weakened to allow the `CONTRACT_BALANCE` flag | 1 test |

A test that has never failed has not been shown to work. Any future test guarding
a money path or an invariant should be mutation-checked the same way before it
is trusted.

**Invariants are executable.** Invariant 6 (0% fee) and invariant 3 (bundled
registry) have tests, including one that scans built calldata for any address
that is not the router, the token, WETH or a sentinel — so a fee recipient
cannot be smuggled in as a parameter.

---

### D-018 — P1b is Doppler, split into read path and write path
**Decided 2026-08-03.** Venue order approved by Rory: Uniswap V3 → Doppler → flap.sh.

Doppler is the largest V4 launch venue on the chain — 173 of 660 recent pool
initializations (26%) — and it did not appear in the original seed corpus at
all, because that corpus was scraped before Doppler grew (D-014).

**Doppler inverts the venue shape.** There is no launch factory and no curve
contract: the launchpad *is* a Uniswap V4 hook. So attribution comes from the
hook's `getState(asset)` rather than a creation trace, and `claims()` is one
static call on the hook rather than a read on the token.

**Split by integration layer** (CLAUDE.md spec discipline), because the two
halves carry very different risk:

- **P1b-1 (done):** read path. `claims`, `state`, `quoteBuy`, `quoteSell` —
  verified live at 0.001 ETH → 18,099,829.24 OKC.
- **P1b-2 (next):** write path. V4 swaps go through UniversalRouter's
  `execute(commands, inputs)` with Permit2 approvals. Neither encoding has been
  read out of the deployed source yet.

**The unimplemented methods throw rather than return.** `approvalNeeded` in
particular must not return `null`: `null` means "nothing to approve", which
would tell the trade engine a sell was ready to broadcast when its Permit2
approval had never been built. A loud refusal beats a silently wrong answer.
The harness reports this as a normal state rather than crashing.

**`Quote.feeBps` becomes `number | null`.** Doppler pools carry V4's dynamic-fee
flag, so no single rate is correct. A `-1` sentinel was written first and then
removed: a negative bps would silently poison any downstream fee arithmetic,
whereas `null` forces a caller to handle the case.

---

### D-019 — Bind V4 contracts by `poolManager()`, never by name
**Decided 2026-08-03.** Extends D-009's rule from V3 to V4.

**Every contract merely named `UniversalRouter` on this chain binds to a
different PoolManager.** All four name-search hits serve foreign V4 deployments.
The two routers that actually carry traffic (`0x53BF6B06…`, `0x8876789976…`)
expose no `factory()` — which is exactly why the V3 census could not validate
them — but do expose `poolManager()`, and both bind correctly.

So: a V4 contract is usable only once its `poolManager()` equals ours, exactly
as a V3 contract needs its `factory()` checked. Name is not evidence, and the
absence of one binding method does not mean a contract is unverifiable — check
the binding the contract actually exposes.

The four bound `V4Quoter` deployments all return identical quotes; one is pinned
in the registry so quotes stay reproducible.

---

### D-020 — V4 encoding is read from the deployed router, never from upstream Uniswap
**Decided 2026-08-03.**

This chain hosts **two** UniversalRouters that both bind to our PoolManager, and
they are not the same contract: `0x8876789976…` has `COMMAND_TYPE_MASK = 0x7f`
and an extra `executeSigned`, while `0x53BF6B06…` matches canonical Uniswap at
`0x3f`. Upstream constants are therefore not automatically valid here.

`0x53BF6B06…` is pinned, on evidence rather than preference: its constructor
args wire it to **our** Permit2, **our** WETH, **our** V3 factory and **our** V4
PoolManager. Every command byte, action byte, sentinel and struct in the write
path was extracted from its verified source.

Same rule as D-009 and D-019, one level deeper: on a chain full of forks, the
deployed bytecode is the specification.

---

### D-021 — Doppler sell availability is per-pool; quote before offering a sell
**Recorded 2026-08-03. Cause UNCONFIRMED.**

Sells revert on 3 of 4 sampled `Locked` Doppler pools — at every size, including
one token — while buys succeed at every size. One Locked pool sells normally, so
this is **not** a protocol-wide "auction is buy-only" rule.

The adapter is not at fault: the identical encoding sells successfully against
the pool that permits it, verified by simulation.

**Consequence for the UI:** a sell control must never be rendered from `state()`
or from holding a balance. It must be gated on a successful `quoteSell`, and
show "cannot sell right now" when the quote reverts. Shipping a sell button that
always fails would be worse than shipping none.

Most likely explanation is one-sided liquidity while the auction distributes,
but that is a hypothesis. Revisit when a Graduated Doppler asset can be observed.

---

### D-022 — Keystore design: scrypt N=2^17, AES-256-GCM, AAD-bound header
**Decided 2026-08-03.** Implements CLAUDE.md invariant 1.

- **scrypt N=2^17, r=8, p=1, dkLen=32** — ~134 MB and roughly a second per
  derivation. Memory-hard so a stolen browser profile is throttled by RAM, not
  just hash rate. Parameters are stored **inside each vault**, so the cost can
  be raised later without stranding existing vaults.
- **AES-256-GCM** — authenticated, so a tampered vault fails to decrypt rather
  than yielding garbage that then gets signed with.
- **AAD binds the header** (`hoodini-keystore-v1:<address>`) to the ciphertext,
  so editing a vault's address fails authentication rather than silently
  decrypting under another identity.
- **`scryptAsync`**, not the sync variant: the sync one would stall the service
  worker for the entire derivation.
- **Password is NFKC-normalised** so a composed and decomposed "é" are the same
  password, as they are to the person typing.

**The key is never returned from the session.** `KeystoreSession.withKey(fn)`
passes it as an argument and there is no getter, so a caller cannot retain it
past a lock without an obvious, reviewable copy.

**The vault stores the address in plaintext** so the UI can name a locked
account. Local-only disclosure: it is never transmitted (invariant 2), and
anyone who can read that storage can already read the ciphertext.

---

### D-023 — Invariants that are testable are tested, including by reading source
**Decided 2026-08-03.**

Invariant 1 ("keys never leave the device") is now enforced by a test that
strips comments from every keystore source file and asserts the code contains no
`fetch(`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, dynamic `import(`,
`eval(`, any `chrome.storage`/`localStorage`/`indexedDB` write, or any
`console.*` call. Crude, but it is precisely the claimed property, and it fails
loudly the moment someone adds a network call to the keystore.

Comments are stripped first: the prose necessarily *mentions* `chrome.storage`
to explain why the module does not use it, and matching that was a false
positive on the first run.

The earlier "core exports nothing matching /sign|send|wallet|privateKey/" check
was too blunt once real key custody arrived — it forbade the keystore itself.
Replaced by two sharper checks: no broadcast path may be exported, and the
key-touching export surface must match an explicit list, so a new key-handling
export is a deliberate edit rather than something that appears alongside a
feature.

---

### D-024 — Content scripts are untrusted; the surface policy is enforced centrally
**Decided 2026-08-03.** Implements CLAUDE.md invariant 3 and ARCHITECTURE.md's
trust boundary.

A content script runs in the page's world. Any site can reach it, so anything a
hostile page can make it send, it will send. Content scripts may eventually
*request a trade*; they may never unlock, export, or sign.

`protocol.ts` declares which surfaces may send each message, and the router
checks it once at the front door. Handlers never receive a message they are not
allowed to serve, so none has to remember the rule and none can weaken it
locally.

**Two independent defences:**

1. `ALLOWED_SURFACES` — the policy table. Today it grants pages **nothing**;
   the first page-facing capability arrives with the trade engine in P2c.
2. `NEVER_PAGE_ACCESSIBLE` — a backstop refusing unlock/export/create/import/
   changePassword/reset to a page even if the table is edited wrongly.

`classifySender` fails closed: a sender carrying `tab` is a page regardless of
the URL it claims (a content script can spoof `url`, not `tab`), and a message
from another extension is refused outright.

---

### D-025 — Redundant defences must each be proven independently
**Decided 2026-08-03, prompted by a surviving mutation.**

Deleting `NEVER_PAGE_ACCESSIBLE` entirely broke no test. The backstop is
redundant *given the current table*, so every assertion passed on the table
alone — yet the backstop's entire purpose is to hold when the table is later
edited wrongly, which is exactly the case nothing exercised.

`isAllowed` now takes an optional policy table so the backstop can be tested
against a deliberately sabotaged one. The test also asserts the backstop is
narrow — a non-sensitive entry is still governed by the table — so it cannot
degrade into a blanket denial that would mask policy mistakes.

General rule: when two defences cover the same case, at least one test must
isolate each. Otherwise the weaker one can be removed silently and the
remaining coverage will look unchanged.

---

### D-026 — A page may quote, but may not spend
**Decided 2026-08-03.** The first page-facing capability.

`trade.quote` is now reachable from a content script: it is read-only public
chain data, touches no key, and a button on a site cannot show a price without
it. The handler deliberately returns **no calldata** — a page has no use for
ready-to-sign bytes.

`trade.execute` stays popup-only, and is listed in `NEVER_PAGE_ACCESSIBLE`.
ARCHITECTURE.md calls for a page to *request* a trade which the user then
approves in extension UI. That confirm sheet does not exist yet. Granting
execute now and building the confirmation afterwards would leave a window in
which any matched site could spend funds — so the capability waits for the UI
that makes it safe, not the other way round.

The page-accessible set is asserted as an exact list, so widening it is a
deliberate edit with this entry to justify it.

---

### D-027 — `LIVE_TRADING` is a build-time constant, checked at the send boundary
**Decided 2026-08-03.** Implements CLAUDE.md invariant 5 and D-004.

**Build-time, not runtime.** A released build cannot be persuaded to broadcast
by a page, the popup, or corrupted storage. Going live requires deliberately
rebuilding:

```
VITE_LIVE_TRADING=true pnpm --filter @hoodini/extension build
```

The default is false, so an accidental release is inert.

**Checked immediately before `sendRawTransaction`**, inside the one private
method that can broadcast — not at construction and not at plan time. Anything
between an earlier check and the send could invalidate it, so the only check
that counts is the one on the same call.

**A dry run is a real rehearsal.** With the gate closed the engine still
`eth_call`s every step against live state and reports which would revert, rather
than returning a no-op that proves nothing.

**Canary ceiling: 0.005 ETH**, summed across *every* step so value hidden in an
approval cannot slip past, and enforced in simulation too so the limit is never
first discovered on the live attempt.

Separation of duties makes this enforceable: `@hoodini/core` plans and exports
no broadcast path (asserted by test), so signing and sending exist only in the
service worker, which is exactly where the gate is.

---

### D-028 — An unresolved in-flight trade blocks trading and is never auto-resent
**Decided 2026-08-03.**

MV3 tears the service worker down at will, including between signing and
receiving a receipt. A journal entry is written **before** each broadcast and
cleared after the receipt, so the next worker lifetime can distinguish "never
sent" from "sent, outcome unknown".

An unresolved entry refuses further trading and is **never** auto-resent:
resending a transaction whose fate is unknown is precisely how a double-spend
happens. Resolution is a human decision after checking the chain.

Sends are serialised behind a FIFO queue and the pending nonce is read
immediately before each signature, so two concurrent trades cannot claim the
same nonce. A rejected trade must not poison the queue, which is tested
explicitly.

---

### D-029 — Overlays render in a shadow root
**Decided 2026-08-03.**

Trading terminals ship aggressive global CSS. Without isolation their
stylesheet would reshape our controls while ours leaked into their layout, and
neither side can be asked to cooperate. A shadow root makes both impossible.

It also makes the overlay auditable from the page's side: everything Hoodini
adds is a single `[data-hoodini]` host element, and `unmountAll` restores the
page byte-for-byte (asserted by test).

Controls call `stopPropagation`, because a terminal usually has its own click
handler on the row — without it, buying would also fire the site's action.
Both buy and sell paths are tested, after a mutation showed only sell was
covered.

---

### D-030 — Row anchoring is inferred from shape, not class names
**Decided 2026-08-03.**

An address usually sits on a `<span>` or `<a>` too small to host a button; the
useful anchor is the row it belongs to. `nearestRow` walks up to the first
ancestor with several same-shaped siblings and enough text to be a row.

Class names would be the obvious alternative and are the wrong choice: terminal
CSS is minified and changes without warning, so a selector-based adapter breaks
silently on a deploy. Shape survives that.

Virtualised lists recycle a row node for a *different* token, so `mount` rebinds
an existing host rather than trusting that a decorated node still shows the same
token — otherwise a click would buy something the user is no longer looking at.

---

### D-031 — The Axiom adapter throws rather than returning empty
**Decided 2026-08-03.**

Axiom's markup has never been observed (Cloudflare bot protection, and
defeating that is out of scope), so its selectors cannot be written honestly.
The stub throws `AxiomAdapterNotReady`.

A stub returning `[]` would be worse than no adapter at all: it would look
finished, silently match nothing, and no test here could distinguish "Axiom
changed its DOM" from "we never implemented it". Throwing makes the gap
impossible to miss.

Axiom is not unsupported meanwhile — `GenericAddressAdapter` decorates it
wherever it renders raw addresses. It is just not first-class.

---

### D-032 — flap's live trade path is `swapExactInput`; `buy`/`sell` are dead
**Decided 2026-08-03. Corrects the P1b-1 census.**

The Portal's ABI exposes `buy(address,address,uint256)` and
`sell(address,uint256,uint256)`, and an earlier census recorded them as flap's
trade surface. Both bodies in the deployed verified source are
`revert FeatureDisabled()`.

An adapter written from the ABI would have compiled, passed review, and failed
for every user — the exact failure mode D-020 exists to prevent, now confirmed
on a second venue. **An ABI describes what a contract will accept, not what it
will do.**

The live path is `swapExactInput`, with `address(0)` for the native asset in
either direction and no recipient parameter, so output goes to `msg.sender` and
built calldata binds to whoever signs it. Neither dead function is declared in
our ABI, making a call to one a type error rather than a runtime revert.

Approvals are plain ERC-20 to the Portal — `permitData` is left empty — so flap
does *not* use Permit2. Assuming venues share an approval model would have been
wrong in both directions.

---

### D-033 — flap `state()` reads `pool`, not `status`
**Decided 2026-08-03.**

`getTokenV9Safe` returns both a `status` enum and a `pool` address. State is
derived from `pool`: an address only exists once liquidity has migrated off the
curve, which is directly observable.

`status` is undocumented in the verified source and no graduated flap token was
found during recon, so any mapping of its values would be a guess presented as a
fact. Same discipline as the Doppler enum (which *was* documented, and so was
used).

**Sell quotes can revert** when the amount exceeds what the curve's reserve can
pay — an arithmetic underflow, not a rejection. Combined with D-021, that is now
two venues where a sell control must be gated on a successful `quoteSell` rather
than on the user holding a balance. Treat that as the general rule.

---

### D-034 — Site selectors are a hint; shape is the fallback
**Decided 2026-08-03.**

X, Telegram Web and DexScreener share one adapter with different
`anchorSelectors`. Selectors are tried in order and, when none matches,
`nearestRow`'s shape heuristic takes over.

That fallback is what makes shipping unverified selectors defensible. None of
the three has a captured DOM snapshot, and X in particular changes markup
without notice. With the fallback, a stale selector costs *precision* — the
control lands on a slightly wrong block — instead of removing the overlay
entirely and looking like the extension is broken.

`data-testid="tweet"` is preferred on X because it is the site's own test hook
and vastly more stable than its generated class names. A malformed selector is
caught and skipped rather than taking the adapter down.

---

### D-035 — Positions are local, partial, and say so
**Decided 2026-08-03.**

There is no indexer and no backend (invariant 4), so holdings are computed by
reading `balanceOf` for tokens the extension has actually seen — a watchlist
populated when a token is quoted or traded.

This cannot be a full portfolio: a token bought elsewhere will not appear. The
panel states that outright rather than showing a total that looks
authoritative.

Two related honesty rules:

- A position whose value cannot be quoted is **kept**, with the reason shown.
  Two venues are known to refuse sells in some states (D-021, D-033), so "no
  price" is a real condition a holder needs to see, not an error to hide.
- The total reports how many positions were excluded from it. A total that
  quietly omitted unsellable rows would read as complete.

`positions.list` is popup-only and in `NEVER_PAGE_ACCESSIBLE`: a page that could
read holdings would learn the wallet's contents just by being visited.

---

### D-036 — Content-script hosts are listed one by one
**Decided 2026-08-03.**

The manifest names all five hosts explicitly. A test asserts every pattern is
`https://<host>/*` — no `<all_urls>`, no scheme wildcard, no wildcard TLD — and
pins the exact host list.

The match list is the most legible security claim a user can check, and
widening it is the cheapest possible mistake to make while wiring up a new
site. Making it a test failure means it cannot happen quietly.

---

### D-037 — MIT licence, with the tradeoff stated
**Decided 2026-08-03. CONFIRMED by Rory 2026-08-03 — MIT stands.**

MIT: conventional for a browser extension, lowest friction for contributors and
for Chrome Web Store review.

**The tradeoff is real and worth naming.** Under MIT a competitor can fork
Hoodini, add a 1% fee, close the source, and ship it. AGPL-3.0 would force them
to publish their changes, which arguably protects the product's whole wedge —
0%, open, auditable.

MIT was chosen because permissive licensing is the norm here and copyleft
deters casual contributors. Rory was shown the fork-and-close risk explicitly
and accepted it, so this is a considered choice rather than a default that was
never examined.

Revisiting it later means relicensing with every contributor's agreement, which
is why it was raised before there were any.

---

### D-038 — Hardening is asserted against the built bundle, not the source
**Decided 2026-08-03.**

Source-level checks miss what a bundler adds. The P5 tests read `dist/` and
assert the shipped JavaScript contains no `eval`, no `new Function`, no
analytics endpoints, and — for the *page-facing content script specifically* —
no `innerHTML`.

That last distinction matters: React uses `innerHTML` internally, so the popup
bundle legitimately contains it. The content script runs inside a hostile page
and must not. Asserting "no innerHTML anywhere" would have been wrong; asserting
it only where it matters is what makes the check meaningful.

The tests skip when `dist/` is absent, so `pnpm test` does not require a build,
but any existing build is checked.

---

### D-039 — The landing page's token address is a constant, never fetched
**Decided 2026-08-03.**

The page displays an address people copy and send funds to. If it fetched that
address, a compromised endpoint or a hijacked domain could swap it — the single
most damaging thing a landing page for a token can do.

So the CA is a hard-coded constant, the page loads no third-party script or
resource, and the copy button stays hidden unless the value matches
`^0x[0-9a-fA-F]{40}$`. A half-set or truncated placeholder never renders,
because someone would paste it into a wallet.

All of the above is asserted by test, along with the required disclosures: the
Robinhood non-affiliation notice (D-015), a plain risk statement, and an
instruction to verify the address independently.

---

### D-040 — Publishing is Rory's, not this project's
**Decided 2026-08-03.**

`docs/CWS-SUBMISSION.md` prepares everything a submission needs — permission
justifications, listing copy, reviewer note, data-disclosure answers — and stops
there. Submitting to the Chrome Web Store, and publishing the landing page, are
outward-facing acts that put Rory's name on a product that custodies user keys.

Those are his to make, not something to do on his behalf because the material
happened to be ready.
