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
**Decided 2026-08-03. Superseded 2026-08-04 by D-050** — the snapshot exists and
the adapter is real, so there is no longer a stub to throw. The reasoning below
is kept because it is why the gap stayed visible long enough to get filled.

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

---

### D-041 — klik's pool key is derived, then verified against the chain
**Decided 2026-08-03.**

Every klik pool uses fixed parameters — native ETH, fee 0, tickSpacing 200, its
own hook — so the `PoolKey` can be constructed from the token address alone,
with no lookup and no bundled data.

Deriving pool identity from assumed constants is normally a bad idea: if a
constant drifts, every quote and trade silently targets a different pool while
looking healthy. So the adapter **proves** its construction. Hashing the key
gives a Uniswap V4 poolId, and klik's own `getTokenPrice` returns the poolId it
uses. A mismatch throws rather than trading.

Verified live: the constructed key, the `Initialize` event and `getTokenPrice`
all produced `0xa4d8acff…40be`.

**Native pairing changes the write path.** klik settles from `msg.value`
directly; Doppler's WETH pools must `WRAP_ETH` into the router first. Wrapping a
native pool settles the wrong currency and reverts, so the shared encoder
branches on the numeraire instead of assuming one shape.

The shared `v4.ts` was extracted for this and Doppler was refactored onto it,
with Doppler's 30 existing tests as the regression guard — they passed unchanged,
which is the evidence the refactor preserved behaviour.

---

### D-042 — Virtuals is deferred; it is not a thin adapter
**Decided 2026-08-03.**

P1d's premise is that each further launchpad is a thin adapter following the
established pattern. Virtuals is not.

`VirtualsBondingAdapter` exposes only `ASSET_TOKEN()`, `sellBase(...)` and
`sellQuote(...)` — callbacks invoked by another contract, with no user-facing
trade entry point and no quote function. Its curve lives somewhere not yet
identified, so adding it means fresh recon of the kind flap and Doppler each
needed, not a config change.

Deferring is the honest call. Writing a Virtuals adapter against the bonding
adapter's callback surface would produce something that compiles and cannot
trade — the same mistake the flap ABI nearly caused (D-032).

---

### D-043 — Sell quotes reverting is normal; treat it as a UI rule
**Recorded 2026-08-03.** Third occurrence, so it is a pattern rather than a quirk.

Doppler (D-021), flap (D-033) and now klik all have pools whose sell quote
reverts while buys work fine — thin curve reserves, one-sided liquidity, or
hook-imposed conditions.

The rule, now general: **a sell control must be gated on a successful
`quoteSell`**, never on `state()` and never on the user holding a balance. The
positions panel already follows it, keeping unpriceable holdings visible with
the reason attached rather than hiding them.

---

### D-044 — `Quote.quoteAsset`: denomination is part of a quote
**Decided 2026-08-03, forced by Virtuals. Supersedes the deferral in D-042.**

Every venue in this project traded against ETH or WETH, so `Quote.amountOut`
carried an implicit denomination that was always the same. Virtuals prices in
**$VIRTUAL**.

That exposed a latent bug rather than merely an inconvenience: the positions
panel summed `amountOut` into an ETH total. Once a Virtuals position existed,
that total would have added VIRTUAL to ETH and produced a number that was not
slightly wrong but meaningless — and entirely plausible-looking.

So `Quote.quoteAsset` is now explicit: `null` for native ETH, otherwise the
ERC-20 the venue prices in. `summarise` counts a non-ETH position as *unvalued*
rather than adding it, and the panel already reports how many rows it excluded.

**`buildBuy` on Virtuals throws.** The interface names the parameter `ethIn`,
and a caller reaching it believes it is spending ETH. Spending that many VIRTUAL
instead is a silent, expensive mistake, so a buy requires the explicit
`buildBuyWithAsset`. Routing ETH → VIRTUAL → agent token is a multi-hop
capability the trade engine does not have, and faking it here would hide the hop
from the confirm sheet.

**D-042 was half right.** `VirtualsBondingAdapter` really does only expose
callbacks — but it is not the trade surface. `BondingV5` is, and it was found by
following a real `sell` transaction rather than by searching names. The lesson
generalises: when a contract's name suggests it should be the entry point and
its interface disagrees, follow a transaction.

---

### D-045 — Fixed-parameter V4 hooks are config, not adapters
**Decided 2026-08-03. Delivers what P1d promised.**

Clanker, CashCat, Pump (V4) and EthCreatorFee are each "a V4 pool with our hook,
always the same parameters". One `V4HookAdapter` plus a four-row config table
covers all of them, reusing the shared encoder from D-041.

**Existence is proved against Uniswap, not against the venue.** klik could
verify a derived key using its own `getTokenPrice`; these hooks expose nothing
equivalent. So the adapter hashes the key into a poolId and reads
`StateView.getSlot0` — an uninitialised pool returns `sqrtPriceX96 == 0`. That
generalises to *any* V4 hook, and needs no cooperation from the venue.

The negative control matters as much as the positive one: the same token under a
different hook hashes to a poolId that reads back zero, so a derived key cannot
quietly resolve to some other pool.

**Two hooks were deliberately excluded**, and recorded rather than skipped
quietly:

- `0x593da569…` — 142 pools, but **two** parameter sets, so no single config
  describes it and the key is not derivable. Source unverified.
- `0x3bff0db3…` — every pool uses a different numeraire. No fixed shape.

Adding either would mean pool discovery by log scan, which `claims()` forbids as
it must stay a single cheap call.

---

### D-046 — `claims()` must be bounded, not literally one call
**Decided 2026-08-03. Corrects an over-constraint in D-005 and D-045.**

D-005 specified `claims()` as "a single cheap on-chain read — never an unbounded
log scan". The intent was *bounded*; "single" was the wrong word for it, and it
caused two venues to be excluded that were perfectly tractable.

`V4HookAdapter` now probes a fixed list of pool shapes and stops at the first
initialised one. Two shapes means at most two static calls. That is still
bounded, still no scan, and it resolves a venue the earlier rule ruled out for
no good reason.

**Token/token venues need bundled pair data.** `rwa-pairs` opens pools between
two ordinary tokens with no ETH side, so the counterparty is not derivable from
a token address. It is bundled — both directions of every pair, since either
side may be the token the user is looking at — and updated by cutting a release,
exactly as the venue registry is. A token missing from the map is **not
claimed**, rather than silently keyed against `address(0)`.

Such a pool is denominated in its counterparty, so its quotes carry a non-null
`quoteAsset` and an ETH-funded buy is refused (D-044).

---

### D-047 — `0x593da569…`: excluded for the right reason this time
**Corrected 2026-08-03.**

D-045 excluded this hook because its pool key was "not derivable". **That was
wrong.** It opens exactly two shapes per token, both native-paired, and both
keys were derived and confirmed live against `StateView` — real liquidity, real
prices.

The genuine blocker is that `V4Quoter` reverts on both shapes with
`UnexpectedRevertBytes`, the wrapper error meaning the hook reverted underneath.
It presumably wants `hookData` or an allowlisted caller, and its source is
unverified, so what it wants cannot be read.

It stays unregistered — but now on evidence rather than on a guess I had not
checked. Registering it would make `claims()` succeed for ~71 tokens whose
quotes always fail, and a button that never works is worse than an honest
"unsupported venue".

Worth stating plainly: an exclusion is a claim about the world, and deserves the
same evidence as an inclusion. This one did not have it.

---

### D-048 — `0x593da569…`: three hypotheses, two wrong, still unsupportable
**Investigated 2026-08-03 at Rory's direction. Supersedes D-047's reasoning.**

Pushed to dig further, and it was worth doing — the second explanation was
wrong too.

1. **"The key is not derivable"** (D-045) — wrong. Two shapes per token, both
   derived and confirmed via `StateView`.
2. **"The hook requires `hookData`"** (D-047) — **also wrong**. Two historical
   successful swaps were decoded and both carried `hookData = 0x`. Empty. The
   quoter was already passing exactly what real swaps pass.
3. **A state or time condition inside the hook** — consistent with everything
   observed, and unverifiable because the source is unverified.

**What the effort produced.** The venue's entry point is the aggregator router
`0x65050A9b…`, and its `swap(...)` signature is now decoded and confirmed —
replaying a real transaction with its original expired deadline reverts with the
readable `"Transaction too old"`, which pins the field layout. That router also
carries plain-V4 and V3 routes, so the decode is reusable beyond this venue.

**Why it stays out.** A swap that succeeded at its own block fails at head with a
fresh deadline, zero minimum, and any sender, reverting with empty data. Across
6 tokens × 2 shapes, **0 of 12** pools are swappable, all holding liquidity —
and the `fee=100` liquidity is byte-identical across every token, meaning it was
seeded and never traded.

Registering it would make `claims()` succeed for ~71 tokens whose trades always
fail.

**The wider point.** Two of my three explanations for excluding this venue were
wrong, and both only surfaced because the exclusion was challenged. A negative
result deserves the same evidence as a positive one — and "I checked and it
still does not work" is worth far more than "it cannot be done", which is what I
said twice.

---

### D-049 — The Sell control is gated on a real quote, sized to the real amount
**Decided 2026-08-03.** Closes the gap between D-043 and the code.

D-021, D-033 and D-043 established that three venues have pools whose sell quote
reverts while buys work fine, and concluded a sell control must be gated on a
successful `quoteSell`. The positions panel followed that; the page overlay did
not — it rendered Sell unconditionally, so a click could only ever fail.

**Probed on click, not on mount.** A list of fifty rows would otherwise fire
fifty quotes nobody asked for. Clicking Sell disables the button, probes, then
either emits the intent or shows "can't sell" with the reason on hover.

**Sized to the whole balance.** Availability is *size-dependent* — flap's revert
appeared only above a threshold — so a nominal probe amount would report a sell
that then failed on the real amount. Omitting `amount` on a sell quote makes the
worker read the balance and price exactly what would be sold.

**Quoting no longer requires an unlocked wallet.** Only approvals need an
account, and a quote does not build them. The old code refused to quote a sell
while locked, which would have made the probe impossible before unlocking. A
whole-balance probe still needs the account, and says `LOCKED` plainly.

**A failed probe re-enables the button.** An RPC hiccup is not evidence the sell
would fail, and permanently disabling a working control on a network blip would
be worse than the bug this fixes.

Two mutations survived the first pass and both were test gaps rather than code
gaps: clicking a `disabled` button is a no-op in jsdom, so the in-flight guard
looked untested until the test dispatched the event directly; and the extension
suite had no coverage of `trade.quote` at all. Both fixed.

---

### D-050 — On a multi-chain terminal, the chain is read per row or nothing is offered
**Decided 2026-08-04.** Unblocked P3; the first rule written from a real DOM.

Axiom's Pulse interleaves Solana, BNB Chain and Robinhood Chain rows in the same
column. So an `0x…` address on that page is not evidence of a Robinhood Chain
token, and the captured DOM contains the proof: `0xffea30fa…149a7777` and
`0x05274cf4…26187777` both carry the `7777` suffix I had been reading as the
Robinhood launchpad's vanity marker, and both are BNB Chain tokens on Flap — per
their own `flap.sh/bnb/…` and `coinmarketcap/token/bsc/…` links.

**Why this is a safety rule and not a polish item.** The same address can exist
on two EVM chains — deterministic deployment makes that ordinary, not exotic. A
detector keyed on address shape would resolve a BNB address against Robinhood
Chain, and if something happened to live there, quote and offer a buy on a token
the user was never looking at. Wrong-chain is not a degraded result; it is a
different asset.

**The rule.** A site adapter for a multi-chain surface must positively identify
each row's chain from that row, and must decorate nothing it cannot identify. A
missing button costs a trade; a wrong button costs the trade.

**Four things that are not chain markers**, all of which looked like one:

| Signal | Why it fails |
|---|---|
| Address suffix `…7777` | Flap uses it on BNB too — two examples in one capture |
| Image CDN host | Robinhood rows are served from `axiomtrading-eth-v2`, same as Ethereum |
| `alt="ETH"` | Sits on `eth-robinhood-v2.svg`; Robinhood's gas token *is* ETH |
| Quick-buy label `0.1 ETH` | Same reason |

What works is Axiom's own chain badge: `alt="Robinhood"` on `robinhood-logo.svg`,
present on every Robinhood row across both captures and absent from every BNB
row. The adapter accepts either the alt or the filename, and D-025 applies — each
is proven by its own test, because in the real markup they always co-occur and a
mutation showed the alt branch was otherwise unexercised.

**Detection is gated, not just anchoring.** The filter sits in `detectTokens`, so
a foreign-chain address never becomes a `TokenRef` at all. Gating only at mount
time would leave a wrong-chain token in hand for any later caller to quote.

**The generic adapter is now the dangerous one.** `GenericAddressAdapter` has no
chain concept, which is correct for a single-chain explorer and wrong for a
multi-chain terminal — so the content script tries `AxiomAdapter` first, and the
fallback never sees axiom.trade.

**Anchoring, decided by the same capture.** Each card carries *two* quick-buy
buttons (`block sm:hidden` and `hidden sm:block`), so anchoring on "the buy
button" would mount twice, once invisibly; and the desktop one lives in a
container that is `opacity-0` until hover below `xl`, which would have hidden our
control at exactly the width the snapshot was taken at. The anchor is therefore
the card — defined by shape, as the smallest ancestor holding both the address
and a buy control, since Axiom's markup is pure Tailwind utilities with no
`data-*` and no ids (D-030 again, and this time against a page I have seen).

**A note on the tool.** The first capture script gave up when it found no full
address, which is precisely what happens on all three terminals — they render
every contract truncated. It bailed silently, left the clipboard untouched, and
reported nothing about a page it could read perfectly well. A capture tool that
only works in the easy case is not a capture tool; v2 reports which mode found
the rows, because "the full address is not in the text" is itself the finding
that decides how detection has to work.

---

### D-051 — When chain and address share an attribute, the gate is parsing
**Decided 2026-08-04.** GMGN and Terminal adapters; extends D-050.

Both sites put the chain and the address in a single attribute value:

```
GMGN      href="/robinhood/token/0xd82f70f5…"
Terminal  src="https://thumbnails.padre.gg/ROBINHOOD-0x5ebe38f4…"
```

This is a materially better arrangement than Axiom's, where the chain lives in
a badge and the address in an image URL. There the two *can* be read apart, and
reading the address without the chain is the exact mistake D-050 exists to
prevent — the gate is a check someone could forget to call. Here it is a
property of parsing: a locator pattern must capture both named groups or it
yields nothing, so an address cannot enter the adapter unaccompanied.

The chain group is therefore **mandatory, not optional**. A config supplying a
pattern with only an address group detects nothing rather than silently
dropping the gate, and there is a test for exactly that — the machine is
exported, so a future config is the realistic threat, not today's two.

**One machine, two configs**, following D-045. The sites differ in their
locator and their anchor, not in their logic. GMGN gets an `anchorSelectors`
entry because it ships Sentry instrumentation naming its React components
(`data-sentry-source-file="TokenItem.tsx"`) — the most semantic hook any of the
three terminals offers. Terminal gets none: its `css-*` classes are emotion
hashes that change every build, and MUI's stable globals describe the button
rather than the row, so shape is the honest option.

**A guard that only mutation testing could have found.** On Terminal the
address lives on the token thumbnail, so the natural anchor is an `<img>`.
`appendChild` on an image succeeds and renders nothing — every assertion about
mounting would have passed while the user saw no button. The adapter now climbs
off any element that cannot host a child. This is the second time in this
project that mutation testing found a real defect rather than a test gap, and
both times the defect was invisible to reading the code, because the code did
exactly what it said.

**Two more host permissions.** `gmgn.ai` and `trade.padre.gg` now appear in the
manifest, taking the content-script list from five hosts to seven. That list is
the most legible security claim the extension makes (invariant 3), so the test
asserting it is an exact equality: adding a host has to turn a test red rather
than slipping in behind an adapter. Whether seven hosts is the right shape for
a first Chrome Web Store submission is a product question, and it is Rory's.

**Not verified against the live sites.** The adapters are built from committed
snapshots and tested against fixtures that mirror them. No one has watched
either overlay render — the same caveat P4's selectors carry, and it applies to
Axiom too.

---

### D-052 — Loading the extension found two things no test could
**Decided 2026-08-04.** The first time any of this ran in a browser.

Everything up to here was verified against fixtures built from DOM captures.
That was worth doing — it caught the chain-marker traps and the `<img>` anchor —
but the first real load produced two failures that no fixture could have
surfaced, because both depended on the page actually painting.

**The overlay was sliced in half.** It appended into the card's flow, which is
right for a tweet and wrong for a terminal: Axiom's cards are fixed-height, lay
their contents out absolutely, and clip the overflow. Measured on the live page,
the control landed at offset 110px in a 115px card that clips at 116px, and for
the second card it was outside the clipping box entirely. The overlay now takes
a `placement` and is positioned against the anchor instead. Flow remains the
default, because a tweet grows to fit and positioning there would be wrong.

**The buy presets were decoration.** `OverlayIntent` carried `{side, token}`
and nothing else, so every preset button emitted an identical intent and the
content script quoted a hardcoded 0.001 whichever one was pressed. Every test
passed. They were all asking whether an intent was emitted, and one always was.

Both were invisible to reading the code, and neither is exotic. The lesson is
narrower than "test more": a fixture proves the DOM you *modelled*, and a
rendered page is the only thing that proves geometry. Two diagnostic scripts
now live in `scripts/` for exactly this — one that walks the detection chain
against a live page, one that reports why a mounted control cannot be seen.

**A note on the debugging.** The first three attempts to find this failed
because the extension reports scan errors through `console.debug`, which Chrome
hides unless Verbose is enabled. Being invisible by default is a poor property
for the only channel that says what went wrong.

---

### D-053 — Settings are read by the page and written only by the popup
**Decided 2026-08-04.** Buy presets and slippage become editable.

The presets decide how much a button spends and slippage decides how much of a
trade the user will tolerate losing. Both are therefore spending decisions, and
they split across the trust boundary accordingly:

- **`settings.get` is page-readable.** The overlay cannot draw its buttons
  without knowing the presets, and what someone's quick-buy is set to tells a
  site nothing it could not learn by watching a trade happen.
- **`settings.set` is popup-only, and joins `NEVER_PAGE_ACCESSIBLE`.** A page
  that could write settings could widen slippage to 50%, raise a preset, and
  wait to be clicked. That is the same class of capability as `trade.execute`
  and gets the same treatment (D-026).

**Validation lives in core, not the form.** A preset arrives as text, survives
in storage, and is later turned into wei — so it is checked where it enters,
not where it is used. Putting the check in the popup would mean two copies of
what counts as a valid spend amount, and the copy that matters is the one
nearest the money. The popup shows what the worker says and gets out of the way.

**Reading forgives, writing does not.** `normaliseSettings` is total: corrupt
storage, a hand-edited value, one bad row among four — each degrades to
something usable, because a settings read failing would break the overlay for a
reason nobody could diagnose. `validateSettings` refuses, with a message naming
the offending value, because someone who typed `0,5` needs telling rather than
silently overruling. Two functions, two moments, and a test asserting they
disagree on the same input.

**Presets are deduplicated by value, not by spelling.** `0.10` and `0.1` are one
button; rendering both would give the user two controls that spend the same
amount and no way to tell them apart.

**The ceiling here is not a safety mechanism.** `MAX_PRESET_ETH` stops a typo
becoming a button, nothing more. The canary limit and the `LIVE_TRADING` build
flag are the safety mechanisms, and they sit at the send boundary where they
cannot be bypassed by anything stored.

---

### D-054 — A page may propose a trade; only extension UI may approve one
**Decided 2026-08-05.** Builds the mechanism D-026 said had to exist first.

D-026 kept `trade.execute` popup-only and said why: the architecture calls for
a page to *request* a trade and the user to approve it in extension UI, that
confirm sheet did not exist, and granting execute first would leave a window
where any matched site could spend funds. The sheet's worker half now exists,
so the request half can land — without `trade.execute` ever becoming
page-reachable.

**What a page gains.** `trade.request` records a proposal and returns an id. It
moves nothing and cannot be made to move anything. The worst a hostile or
compromised site achieves is a prompt nobody asked for.

**What stays out of reach.** `trade.approve`, `trade.reject` and `trade.pending`
are popup-only and in `NEVER_PAGE_ACCESSIBLE`. A page that could approve would
not need the user; one that could read what is pending would learn what the user
is about to do. Both would make the prompt theatre.

**One outstanding request, and a second is refused rather than substituted.**
Substitution is the classic attack on a confirmation dialog: the user reads
request A, reaches for approve, and the page swaps in B just before the click.
Refusing means what is on screen is what was asked for and stays that way until
it is answered. A queue has the same flaw one layer down — approving the top of
a list a page can push to is approving something a page chose the position of.

**Approval consumes the request before the trade runs, not after.** A double
click or a duplicated message therefore cannot spend twice. If the trade then
fails the user proposes again, which is a much better failure than a second
send.

**Requests expire after two minutes, checked on read.** An unanswered proposal
left overnight is a click waiting to happen against a price that no longer
exists. Checked on read rather than by a timer because MV3 kills the worker
whenever it likes and a timer is not something this environment can be trusted
to run. Held in worker memory for the same reason: a proposal that survived a
restart would be a confirmation for something the user scrolled past long ago.

**The origin comes from the sender, never the message.** A page that could name
its own origin could name someone else's, and the only value in showing it is
that it cannot be forged.

**Approval re-dispatches through `trade.execute`.** Confirmation adds a step and
changes nothing about how a trade is planned, gated or sent — the canary
ceiling, the serialised nonce, the in-flight journal and the `LIVE_TRADING`
build constant all still sit exactly where they did.

**The page surface went from two capabilities to three.** The test asserting
that list is an exact equality, so this required a deliberate edit with the
reasoning attached — which is how it should have to work.

**No UI yet.** This is the worker half. Nothing calls `trade.request` and no
confirm sheet renders, so the observable behaviour of the extension is
unchanged. Wiring the overlay to propose, and building the sheet, is the next
slice — split per CLAUDE.md, since the security surface and the interface have
independent risk.

---

### D-055 — The confirmation shows what is true, and the badge is the only honest nudge
**Decided 2026-08-05.** P6b, the interface half of D-054.

**A buy click proposes; it does not price.** The overlay used to quote and log
the answer nowhere the user could see it. Now it sends `trade.request` and the
button says `confirm ↗`, or `one pending` if something is already waiting. The
honest thing to report is where the decision now sits, not a number.

**`onIntent` may answer, and need not.** Adapters that ignore the return value
behave exactly as before, so the change costs nothing to anything that already
worked. The button is disabled while in flight: a double click would otherwise
be a second proposal for the user to dismiss.

**The badge is the nudge, because there is no other.** A content script cannot
open the popup — `chrome.action.openPopup` needs a user gesture in the
extension's own UI — so a proposal with no visible signal would simply expire
unanswered. The badge is not a nicety here; without it the flow does not work.

**The quote is fetched in the sheet, at approval time.** Pricing at request time
and showing it later would put a number in front of the user that the chain has
since moved past. If it will not price, the sheet says so and still offers
Reject: not being able to quote is a reason to hesitate, not a reason to hide
what was asked.

**The sheet states that this build cannot send.** A confirmation that does not
distinguish "this will spend" from "this will simulate" trains the user to click
through it — and the first one that *does* spend would meet a habit rather than
a decision.

**Reasons the user can fix must not cost them the request.** The first version
consumed the request before checking whether the wallet was unlocked, so
clicking Approve while locked destroyed the thing being approved: you unlocked
to find nothing there. Validation now happens without consuming, and consuming
happens immediately before execution — early enough that a double click cannot
spend twice, late enough that a fixable refusal is not punished.

Mutation testing found two gaps that mattered: nothing tested that a
message-supplied `origin` is ignored in favour of the sender's, and nothing
tested that approval consumes. Both are now covered — the first because a
forgeable site name makes the whole confirmation worthless, the second because
consuming after a send rather than before is exactly how something gets paid for
twice.

---

### D-056 — Withdraw exists, is popup-only, and is not capped by the canary limit
**Decided 2026-08-05.** Found by asking how funds come back out, before putting
any in.

Until now you could put ETH into this wallet and get it out only by exporting
the private key into a different wallet. That is a trap, not a design: it makes
the recovery path require copying the one secret the whole architecture exists
to keep in one place.

**Popup-only, and in `NEVER_PAGE_ACCESSIBLE`.** A page that could move ETH would
not bother with the trade path — it would empty the wallet. This is the most
direct theft the extension could possibly expose, so it sits with `wallet.unlock`
and `wallet.export`.

**Not subject to the canary ceiling.** The 0.005 ETH limit exists because a
*trade* amount is computed — by a planner, from a quote, across steps — and a
bug in that computation could produce a number nobody typed. A withdrawal amount
is typed by a human and shown back before they confirm. Its real risk is a wrong
**address**, which no ceiling addresses. Capping it would also defeat the
purpose: a recovery path that cannot move more than 0.005 ETH is not one.

**It is gated by `LIVE_TRADING` all the same**, checked immediately before
`sendRawTransaction`, and journalled before broadcast like every other send
(D-027, D-028). A dry-run build plans and validates in full and skips only the
broadcast, so the rehearsal is real.

**The arithmetic lives in core, pure.** Two failure modes, both quiet: reserve
too little and the transaction cannot pay its own gas; reserve too much and a
"sweep" strands funds the user believes they moved. A sweep therefore reserves
the fee at `maxFeePerGas` — the cap that will actually be signed — rather than
an estimate, because a sweep computed from anything lower fails the moment the
base fee ticks up. Nine mutations, all caught.

**Two presses, not one.** The address is typed, then shown back checksummed
beside the exact amount, and only the second press sends. Sending to the wrong
address is the failure nothing can recover from, and the one validation cannot
catch: `0xabc…` is a perfectly valid address that simply is not yours.

**Refusing to send exactly the balance.** The most natural way to try to empty a
wallet, and the one that always fails. It is refused here with a sentence
pointing at Max, rather than by the node with a revert.

---

### D-057 — Venue resolution is concurrent and cached; the confirmation is the remaining cost
**Decided 2026-08-05.** Measured, not guessed.

A terminal overlay competes on speed, so the first thing worth knowing is where
the time actually goes. Against the live chain, with a ~200–580ms RPC round
trip:

| Step | Before | After |
|---|---|---|
| `resolve()` cold | 3,605 ms | 1,233 ms |
| `resolve()` warm | 1,064 ms | **0 ms** |
| quote | ~200 ms | ~200 ms |
| build calldata | ~200 ms | ~200 ms |
| **warm click → calldata ready** | ~1,470 ms | **456 ms** |

**`claims()` was sequential.** One RPC round trip per adapter, eleven adapters,
paid on every click because nothing was cached. It is now probed concurrently
and decided by registry rank afterwards — the answer is identical, because rank
was always what decided it; the only change is that every adapter is asked
rather than stopping at the first yes. That costs some read load and buys back
seconds.

**Positive resolutions are cached; negatives are not.** A token's venue does not
change once its pool exists. But a token that has *just* launched legitimately
goes from unclaimed to claimed within seconds, and caching that no would leave
the newest tokens — the ones this product exists for — unsupported for the life
of the worker.

**The engine's three pre-sign reads now go together.** Nonce, gas estimate and
fees are independent of one another; they were three sequential round trips
before a single byte could be signed. The nonce is still read immediately
before signing, which is the property that mattered.

**What remains is not code.** At ~456ms warm, the machine is no longer the slow
part — the confirmation is. Click, badge, open the popup, read it, approve: that
is seconds of human time, and it is deliberate (D-026, D-054). Making trading
genuinely instant means giving something up, and that is a product decision
rather than an optimisation:

- **Prefetching a quote** when a control mounts costs nothing in safety and
  makes the sheet open with a price already in hand. Built as hover-warming in
  D-058 — on hover rather than on mount, for D-049's reason.
- **Standing consent** — "approve buys under X ETH from this origin for the
  next N minutes" — is how session keys work elsewhere. It is a real weakening
  of D-054's guarantee that every trade meets a human, and it should only ever
  be entered deliberately, bounded by both amount and time.

The first is built in D-058. The second is built in D-059.

---

### D-058 — A hover warms the venue cache; a page still learns nothing

D-057 left prefetching described but unbuilt, and measured why it was worth
building: resolving which venue trades a token was 1,800ms of a 2,016ms click.
Everything else — quoting, building calldata — was noise beside it.

**Warming happens on hover, not on mount.** This is the same rule D-049 settled
for the sell probe, and it settles this the same way: a column of fifty cards
mounts fifty controls and the user is going to click at most one, so mounting is
not evidence of interest. A pointer entering a control is. It also arrives a few
hundred milliseconds before the click, which is exactly the window needed.

Measured on `0x354d…9633`, cold:

|  | resolve | quote | click total |
|---|---|---|---|
| no warm | 1,800ms | 216ms | **2,016ms** |
| after a hover | 0ms | 210ms | **210ms** |

The 1,481ms the hover spends is not saved, it is *moved* — off the critical path
and onto time the user was spending moving the mouse anyway.

**`trade.warm` is a new page capability, and that is the part worth scrutiny.**
The page-allowed list is pinned as an exact list precisely so widening it cannot
happen quietly; the boundary test failed on the first run of this change, which
is the test doing its job. The entry earns its place by being strictly weaker
than the `trade.quote` it accelerates:

- it carries no side, no amount and no slippage — only an address the page
  already rendered;
- it returns `{ ok: true, data: null }` and nothing else, so no price, no
  calldata, no venue id;
- it returns *the same reply* whether resolution succeeded, found no venue,
  threw, was handed a string that is not an address, or ran in a build with no
  trading wired up at all. A differing answer would make it an oracle: a page
  could sweep addresses and learn which are tradeable without asking for a
  quote. Four assertions pin this.

**It deliberately does not touch the watchlist.** `trade.quote` adds the token,
because quoting means the user pressed something. Hovering does not. The
watchlist holds 200 entries and drives the positions panel, so filling it by
moving a mouse down a column would bury what the user actually traded under what
their cursor happened to cross, and make the panel read 200 balances to show it.

**Resolution is fired without being awaited.** A hover must never make the page
wait on RPC, and a warm that fails simply means the click pays what it always
paid. The handler answers immediately either way.

**The confirm sheet still quotes at approval time.** D-055 put it there so the
user never approves against a stale price, and that has not changed — warming
makes that fetch land in ~210ms instead of ~2s rather than replacing it. The
price shown is still fetched when the sheet opens.

Standing consent is built in D-059, uncapped and unexpiring at Rory's instruction.

---

### D-059 — Standing consent: uncapped, unexpiring, armed until disarmed

D-057 left this as Rory's call and D-058 left it unbuilt. The instruction came
back in three parts: build it, **no cap at all**, and **until I disarm**.

**The concern was raised twice and is recorded rather than re-argued.** The
amount in a `trade.request` comes from the page, not from the user's presets:
the content script runs in the site's world, so a hostile or compromised matched
site is not limited to what the buttons say. While every trade meets a human
that is harmless, and it is the whole reason D-026 judged proposing to be safe —
the worst outcome is a prompt nobody asked for. With consent armed and no cap,
the ceiling on one auto-approved buy is the wallet balance. That was stated
plainly, twice, and the instruction did not change. It is the user's call.

**What still refuses, and why none of these is a cap in disguise:**

- **A locked wallet signs nothing.** Not a policy; there is no key in memory.
  Arming is refused while locked too, rather than becoming a switch that
  silently does nothing until the next unlock.
- **Buys only.** A sell is the whole balance (D-049), so it is not a bounded
  amount and "no cap" cannot describe it. Sells keep the sheet.
- **The first live broadcast is always manual.** CLAUDE.md invariant 5 fixes the
  first live test as a canary explicitly approved in-session, and an invariant
  marked permanent is not something a session preference edits. Auto-approval
  refuses until a real broadcast has happened once by hand. The flag is set only
  on `status === 'sent'`, so a simulated run cannot satisfy it.
- **Memory only.** Arming never touches storage. It dies with the worker, the
  browser, or a lock — and MV3 evicts the worker constantly, so "until I
  disarm" means "until I disarm this session". The canary record *does* persist,
  because invariant 5 is about the first live trade ever.
- **Validity is not a limit.** A malformed amount is still refused. Uncapped is
  not unvalidated.

**Arming is popup-only and on the never-page-accessible list**, beside
`wallet.unlock`. A page that could arm this would hold `trade.execute` by a
longer route, which is precisely what D-026 exists to prevent.

**It still goes through `pending`.** The proposal is recorded and then
immediately consumed rather than shortcutting past it, because one-at-a-time,
the origin capture, and the single-use `take()` are properties worth keeping
even when nobody is going to read the sheet.

**The armed state is on the badge**, amber and a dot, distinct from the mint
count that means "answer me". A condition under which money moves with nothing
on screen must not itself be invisible; that is the failure mode this feature
invites. Locking repaints it, so the badge cannot claim armed after auto-lock,
and `consent.status` composes the flag with the live session for the same reason.

**One defect found by writing the tests rather than by running it.** The first
version handed the execute outcome back to the page on auto-approval. A `sent`
outcome carries transaction receipts, and a receipt carries `from` — the user's
address. `positions.list` is popup-only specifically to keep that from a site
(D-053), and auto-approval had quietly become the route around it. The page now
gets `{ id, autoApproved: true }` and nothing else, asserted by a test that
greps the whole response.

---

### D-060 — The canary went out, and 0% is now a measurement

The first live trade, approved by hand in-session on 2026-08-06 as CLAUDE.md
invariant 5 requires. Recorded here because "0% fee" had until now been a claim
backed by tests and by the absence of fee-taking code. It is now backed by a
transaction.

```
hash    0xb89c8b99d2a39570054cc48f863e9dd8344b027b0a0c1b8fa480e7493c915819
block   28834795            status  success
from    0x1A463b7b289AD1C2Ad73Ff95Ea2C048D9BB8e051   (nonce 0 -> 1)
to      0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77   UniversalRouter, execute
value   0.001 ETH
gas     113627 units, fee 0.000002797723994 ETH
out     398019.240430042974631535 YEW (0x3CfDc3924d405c98230099e1826fF846BDBbb804)
```

**The arithmetic is the point.** The wallet went from `0.010189658214` to
`0.009186860490006` ETH, a difference of `0.001002797723994`. Subtract the gas
fee of `0.000002797723994` and the remainder is `0.001000000000000` exactly —
to the wei. There is no skim, no tip, no spread and no third transfer. Every wei
not paid to the sequencer went into the swap. That is the invariant-6 claim,
measured rather than asserted.

**What the canary exercised**, beyond the number: an unlocked keystore signing
in worker memory, the V4 hookless adapter resolving and building calldata, the
`LIVE_TRADING` gate at the send boundary, the journal recording before
broadcast, the 0.005 ETH ceiling (never approached at 0.001), and the confirm
sheet as the only thing that could authorise it.

**What it did not exercise:** the sell path. Three venues are known to have
pools that quote a buy and revert a sell (D-021, D-033, D-043), and the wallet
now holds YEW specifically so that can be tested next.

**Two operational consequences.**

The live artifact was built to `apps/extension/dist-live` rather than `dist`, so
the guard asserting `dist` is dry-run kept passing throughout and no live build
was ever committed. `dist-live` is gitignored. The safe build should be
reinstalled once testing is done: it can spend up to the canary ceiling per
trade, and withdraw is deliberately uncapped (D-056).

The send set the persistent first-live flag, so the invariant-5 gate in D-059 has
now closed and standing consent is able to approve live sends. Uncapped, per the
instruction. Armed, any matched site can propose any amount and it goes without a
sheet — which is a reason to leave it disarmed until it is actually wanted.

---

### D-061 — The sell path had never worked, and a wrong type is why

The canary buy landed (D-060). The sell that followed did nothing at all: nonce
stayed at 1, the token balance was untouched, and the button reported success.
Three defects, in the order they were found, though the last one caused the
second.

**1. The overlay never proposed a sell.** `propose()` took an early branch for
anything that was not a buy-with-an-amount: it called `quote()`, logged the
price at `console.debug`, and returned `{ ok: true }`. No `trade.request` was
ever sent, so a sell could not reach the popup, could not be approved, and could
not execute. The button showed its normal label, because the return said
success.

The comment defending this said the Sell control's own probe had already priced
the balance and that proposing again would ask the worker the same question
twice. It would not. The probe decides whether to *offer* the control; the
request is the thing the user approves. Those are different questions and the
second one was never asked.

**2. An approved sell would have been refused anyway.** `trade.approve`
re-dispatched with `amount: approved.amount ?? '0'`. A sell carries no amount,
so it sent `'0'` — and `trade.execute` reads "sell the whole balance" from the
*absence* of an amount while rejecting an explicit zero as out of range. Every
approved sell would have come back BAD_REQUEST.

**3. The type is what produced defect 2.** `trade.execute` declared
`amount: string` as required, while its handler had always branched on
`amount === undefined`. The type asserted a real code path was unreachable, so
the approve path satisfied the compiler the only way it could, by coercing to
`'0'` — and that coercion is the bug. `trade.quote` had the field optional with
exactly the right semantics all along; `trade.execute` simply disagreed with
itself.

This is worth stating plainly: the type was not merely wrong alongside the bug,
it *caused* the bug. A required field that the implementation treats as optional
does not fail loudly. It pushes a lie into every call site until one of them
picks a plausible-looking value.

**Why no test caught any of it.** Every piece was covered and every piece
passed. What was never covered was a sell travelling propose -> approve ->
execute in one go, which is the only path a real sell takes. Unit boundaries
were exactly where the defects hid. Four tests now cover the whole route,
including that an explicit `'0'` is still refused rather than quietly reinstated
as "everything" — that coercion would look correct if zero meant the balance,
and treating it that way would be a far worse failure than the one being fixed.

**Found by selling, not by testing** — the fifth time this project has learned
something only by running the thing (D-052), and the second where the failure
was shaped like success.

---

### D-062 — The sell went out too, and 0% now holds in both directions

The round trip that D-061 made possible, completed on 2026-08-06. Two
transactions, both successful, from the same wallet as the canary.

```
approve  0x0ef953385bd6f16ab34fdf952e87cb702bc533bf80066cdbb0cf6fe71de6e2f6
         block 28843851  ->  0x0000...8BA3 Permit2      gas 47662   fee 0.000001188785604
swap     0x04188ffb95d1e231fd9a956c3ec7ae90f974a735f024db42e6d28b60e3362dc1
         block 28843867  ->  0x53BF...6F77 UniversalRouter  gas 104416  fee 0.000002583460672
nonce    1 -> 3          YEW balance 398019.240430042974631535 -> 0
```

**The arithmetic, which is the reason to write this down.** 0.001 ETH went in on
the buy (D-060) and 0.000995007240128386 ETH came back on the sell. Excluding
all gas, the round trip cost **0.4993%**. Two 25 bps pool fees compounded is
0.4994%. The entire cost of trading through Hoodini, in and out, is the pool's
own fee and nothing else — invariant 6 measured in both directions rather than
asserted in one.

Net cost of the whole exercise was 0.0000115627 ETH, of which 57% was gas.

**The read-only rehearsal was exact.** Before the sell, a script quoted
0.000995007240128386 ETH out. The realised proceeds net of the swap's own gas
were 0.000991234993852386, and the difference is precisely that gas fee. The
quoting path is accurate to the wei, which is worth knowing given the confirm
sheet prices at approval time (D-055).

**What the sell exercised that the buy did not:** the two-step plan, the Permit2
allowance, `approvalNeeded` returning a step rather than null,
`mayNeedMoreApprovals`, and the whole-balance semantics that D-061 had broken.

The landing page's fee note said network gas "is paid to validators". Robinhood
Chain is an Arbitrum Orbit L2, so it goes to a sequencer. Corrected, and the
measured round-trip figure added, since the page is public and the claim is now
backed by two transactions rather than by tests.

---

### D-063 — The password is the authorisation, and it lasts 25 minutes

Two instructions, taken together because they describe one model.

**Auto-lock moves to 25 minutes** (`DEFAULT_AUTO_LOCK_MS`, was 15). Idle-based,
so it is 25 minutes of nothing happening rather than 25 minutes from unlocking.
Long enough to work a terminal session without the password becoming background
noise typed without reading; short enough that a walked-away-from laptop is not
indefinitely able to sign.

**Standing consent now arms on unlock** rather than by a separate press. D-059
built it off-by-default and armed by hand; the instruction is that auto-buy
should be automatic. So unlocking is the authorisation, and it lasts exactly as
long as the session does.

The consequence, stated once and not re-argued: a fresh unlock now means any
matched site can propose any amount and have it signed with nothing appearing on
screen. The reasoning about page-controlled amounts in D-059 still applies and
has not changed; what has changed is that reaching that state no longer takes a
deliberate act. Everything that still refuses — locked wallet, sells, the
invariant-5 canary gate, malformed amounts — is unchanged.

**The preference is deliberately not a `Settings` field.** `settings.get` is
page-readable (D-053). A preference living there would tell any matched site
whether this wallet approves without asking, which is precisely the fact a
hostile page would want before deciding how much to propose. It lives on
`StandingConsent` behind `consent.status`, which is popup-only, and a test
greps the page-facing settings response to keep it that way.

**Off stays off.** Disarming writes the preference as well as clearing the
armed flag, because otherwise the next unlock would quietly turn it back on and
the off switch would be a fiction. Arming writes it too, so there is one control
rather than a switch and a hidden default that can disagree with it.

**The armed flag itself is still memory-only.** Only the preference persists. A
worker returning from eviction is disarmed until something unlocks the wallet
again, which is what keeps the lock the real boundary rather than the switch.

---

### D-064 — Price, gas, site status, history and approvals

Five surfaces, prompted by reading Rabby. Each is here because it answers a
question a trader actually asks, and each is built without a backend, which
invariant 4 requires and which shaped every one of them.

**A price at last.** Blockscout's `/api/v2/stats` returns `coin_price`, and the
figure checks out: the wallet's 0.010178 ETH at the $1,909 shown there is the
$19.44 Rabby displays for the same address, to the cent. The alternative — an
on-chain stablecoin pool — was investigated and rejected: a token search returns
44 things called "USDC" on this chain, most of them launchpad impostors with 18
decimals and vanity `7777` addresses. Picking one by name would have fabricated
a dollar figure for real money.

Everything from the explorer is parsed rather than trusted. `coin_price` arrives
as a string, and a `NaN` rendered into a balance reads as a real figure of zero,
which is worse than an em dash by a long way. Null propagates to the UI and the
UI shows a dash.

**The two explorer requests are not equally private, and are not treated alike.**
`/stats` carries no address and discloses nothing, so the popup fetches it on
open. A history lookup necessarily names the wallet, which is a genuine
disclosure to a third party even though no key is involved and nothing of ours
is sent. So history loads only when asked, says on screen what the request
reveals, and a test asserts a locked wallet never makes it at all.

**Site status exists because "no buttons" cost two debugging sessions in one
day.** The chain gate refusing a non-Robinhood row and the content script not
having injected look identical from outside. One line — the host, a dot, and
"Hoodini is active" or "not a supported site" — distinguishes them. It reads the
active tab under `activeTab` rather than `tabs`: `activeTab` is granted on the
toolbar click and covers only the tab in front of the user, where `tabs` would
hand over every tab's URL at all times.

The host list moved to `src/hosts.ts`, a leaf module with no imports, because
the popup importing it from the manifest pulled the CRXJS *build* plugin and
Vite's internals into the browser bundle and failed the build outright.

**Approvals are honest about being partial.** Without an indexer the only
truthful scan is the spenders Hoodini can itself cause an approval to — Permit2
and the two routers — against tokens the watchlist has seen. An allowance
granted in another app will not appear, and the card says so rather than
implying the list is complete. Revoking re-dispatches through the engine rather
than signing locally, so the `LIVE_TRADING` gate, the journal and the value
ceiling all apply exactly as they do to a trade.

**A defect worth recording.** `SiteStatus` called `chrome.tabs.query` and caught
rejections, but the call itself throws synchronously when the API is absent —
and an uncaught throw inside a `useEffect` unmounts the whole tree. The entire
popup went blank because a status line could not be drawn. It is wrapped now.
Found by the preview harness having no `tabs.query` stub, which is exactly the
missing-API case the real world produces.

Two origins are now in `host_permissions` where there was one. Both are public
and read-only, both are pinned by an exact-list test, and the Chrome Web Store
submission names the new one and explains what each request discloses.

---

### D-065 — Sells are fractions, and the config is visible where you click

From the trade widget Rory pinned as a reference. Two of its ideas transfer
cleanly; a third does not, and the reason is worth writing down.

**Sells are 25 / 50 / 100% of the holding**, replacing one whole-balance
button. That is how people actually sell, and it gives a sell a bounded amount
for the first time — D-059 refuses to auto-approve sells precisely because "the
whole balance" is not a bound.

**The fraction, not the amount, crosses the boundary.** The control lives in the
page's world with an open shadow root, so anything it is told, a hostile site can
read. `positions.list` is popup-only exactly so a site never learns what someone
holds (D-053), and computing the amount in the content script would have handed
that over on every render. "Sell half" is actionable without anyone in the page
knowing half of what; the worker resolves it against the real balance at the
moment it prices the trade.

**Each fraction probes its own size.** Availability is size-dependent (D-049) —
a venue that pays out a quarter can revert on the whole balance — so one probe
standing for all four would be a button that is sometimes lying. A refused size
disables only itself and the others stay live.

**The arithmetic is integer, and 100 short-circuits.** `balance * pct / 100n`
is exact for every fraction, but only because it never leaves bigint; going via
a float would drop the low digits of an 18-decimal balance. 100% returns the
balance itself rather than multiplying and dividing it, so "sell everything"
means every last wei rather than very nearly all of them.

**An amount and a percentage together is refused**, not reconciled. They are two
different instructions for one trade, and guessing which was meant is not a
thing to do with money.

**Slippage now shows under the buttons.** The reference displays its slippage,
priority fee and tip at the point of action, and it is right to: a number living
in a settings screen means nobody can see what they are about to agree to at the
moment they agree to it. Ours reads from the same getter the buttons do, so an
edit is reflected without a reload.

**What was not taken: the holdings readout.** The reference prints
`0 CASHCAT · $0` beside its sell buttons. In our overlay that is a balance
disclosure to the site, for the same shadow-root reason as above, and the
percentages do not need it — the confirm sheet shows the exact amount before
anything is signed. It is not a small omission and it is not an oversight.

---

### D-066 — Profiles, and the focused panel

The second half of the trade widget Rory pinned. The row controls stay for
scanning a list; this is the other object, for one token held still.

**Profiles carry slippage, not just amounts.** Three configurations, P1–P3, each
with its own presets *and* its own tolerance. That pairing is the whole point:
market conditions differ, and a calm-market preset set with a hot-market
slippage is not a configuration anyone chose. P1 defaults to exactly what the
extension shipped with before, so upgrading changes nothing anybody had set, and
storage written before profiles existed is read as P1 rather than discarded.

**`Settings` keeps flat `buyPresets` and `slippageBps` alongside the profiles.**
Not redundancy — every existing reader asks for those and must keep working
without knowing profiles exist. They are derived in `normaliseSettings`, which
is the only thing that constructs a `Settings`, so they cannot drift from the
profile they mirror.

**Switching profiles in the panel does not write settings.** `settings.set` is
popup-only so that a site cannot quietly widen what a button spends and wait to
be clicked (D-053), and that reasoning does not stop applying because the
control is prettier. A tab switch changes what *this page* draws and submits for
as long as the panel is open. The popup owns the persistent default. This needed
no new capability at all: the page may already read settings, so it can be given
all three and choose locally.

**The panel shows no balance, and cannot be told one.** The reference prints
`0 CASHCAT · $0` beside its sell buttons. An injected panel has an open shadow
root, so anything it renders the site can read, and `positions.list` is
popup-only precisely to keep holdings from a site. Percentages need no such
disclosure. Two tests hold this: one scans the rendered rows and rejects any
number that is not a preset, a percentage or the slippage, and one asserts the
options interface has no channel for a balance in the first place — the stronger
claim, because widening it would be a visible change rather than a quiet one.

**One panel at a time**, by construction. Two would be two configurations on
screen with no way to tell which one a click used.

**Position is stored in extension storage, not the page's.** The page's belongs
to the site, and a panel that moved itself between terminals would be strange.
Clamped into view on read, so a stale coordinate cannot strand it off screen,
and written on pointer release rather than on every move.

Sell fractions became 25/50/75/100 rather than 25/50/100 — Rory's call, and it
matches the reference.

---

### D-067 — The panel belongs to a coin's page; a list keeps the strip

D-066 opened the panel from a button on every row. Wrong: a list is for
scanning, and a control that offers to open a workspace on each of fifty cards
is in the way of the thing the list is for.

**The panel now appears when the page is about one token, and only then.** No
button summons it; it follows the page.

**Detection is the URL, not the DOM.** "The page mentions exactly one address"
is tempting and wrong — a list that has loaded one row and a detail page with a
holders table both defeat it, and they defeat it by opening a trading panel on
the wrong coin. A terminal that gives a token its own page puts the address in
the path, because that is how the page is addressable at all. So the rule is:
the path names an address, *and* the adapter also detected that address on the
page. The first half says the page is about a token; the second says it is one
this extension may trade, because it came through the adapter's own chain gate
(D-050).

Two addresses in the path that are both present answers null rather than picking
the first. Sites that address a page by pair rather than by token — DexScreener
— will not match, and that is the honest outcome: a pair address is not a token
address and guessing which of the two was meant would open a panel that buys the
wrong thing.

**Re-evaluated on every scan**, because these terminals are single-page apps:
navigating from Pulse into a coin never reloads the document, so a check at load
would only ever see the list. Closing the panel is remembered per token, or the
next mutation would reopen what was just dismissed.

**Both surfaces were restyled, and the row strip is the important one.** It was
a row of separate pills with a panel behind them; at 345px on a terminal card
that is most of the card. It is now one continuous strip divided by hairlines,
311×25, with the colour alone carrying buy from sell and the slippage as a
9px tail. On a dense card the gaps between pills were most of what the eye saw.

The panel dropped its outlined buttons for tinted glass and its loose tabs for a
segmented control. At that size a border on every button is most of the ink, and
the colour already says which side you are on.

---

### D-069 — A panel decides whether it can trade, not whether it exists

Three rounds went into "the coin-page panel is not showing", and the cause was
the gate: whether the panel *appeared* was made conditional on a chain probe
succeeding. When the answer was no, nothing appeared and nothing explained why,
which is indistinguishable from a broken extension.

Whether a panel exists is not a question the chain gets to answer. It opens as
soon as a route names a coin. The probe then annotates the panel that is already
there: no Robinhood Chain venue gets a plain amber line saying so, and every
button disabled.

On a multi-chain terminal that answer is frequently and legitimately no — an EVM
address on an Axiom coin page can be a BNB or Ethereum token — so this is the
normal case being made visible rather than an error path being handled.

The wider lesson is the one D-052 keeps teaching: this project's recurring bug
is not wrong logic, it is correct logic that fails silently. A UI that declines
to exist is the loudest version of that.

Also adds `data-hoodini-build` on `documentElement`. Content scripts inject on
page load and never again, so reloading the extension leaves open tabs on the
previous build — which has now twice looked exactly like a real bug.

---

### D-070 — More than one wallet

**One password protects the set.** Each vault is separately encrypted but from a
key derived from the same password, so unlocking decrypts all of them and
switching account afterwards costs nothing. Decrypt-on-demand was the
alternative and it would ask for a password every time somebody changed wallet,
which defeats the feature.

**Adding a wallet does ask for the password again.** The session holds private
keys, not the password, and a new vault cannot be encrypted without re-deriving.
Keeping the password resident to avoid one prompt on a rare action would be a
poor trade.

**`session.address` stayed singular.** Twenty-one call sites ask it to decide
who is about to sign, and every one means "the active account" — so multi-wallet
changes what the answer is, not what the question is. That is why this landed
without touching the engine, the withdrawer or the trade path at all.

**A vault that will not decrypt fails the whole unlock**, rather than being
skipped. A set where one wallet silently vanished would have somebody trading
from a different account than the one they think they selected.

**Selecting an index that does not exist is refused**, never rounded to zero.
Silently signing from a different wallet than the one asked for is the worst
outcome available here.

**Storage migrates on read, not on write.** The single-vault key this extension
shipped with is still read, as a set of one, and nothing is rewritten until
something writes anyway. A rollback or a half-finished upgrade therefore cannot
leave somebody unable to open a wallet that still exists.

**All three messages are popup-only and on the never-page-accessible list.**
Choosing which wallet signs is a spending decision; a page that could make it
could move funds from an account the user was not even looking at.

---

### D-071 — Editing the amounts where you use them

The reference terminal edits its presets in place: a pencil in the header, a
field under each button. That is right — you are looking at the buttons when you
decide they are wrong — and the panel now does the same.

**It needed a page capability, and the reasoning is not symmetric.**
`settings.set` is popup-only because a page that could change what a button
spends could widen it and wait to be clicked (D-053). But that argument does not
apply equally to everything it covers:

- A **buy preset is drawn on the button it sets.** A page that changed one to 5
  ETH would produce a button reading `5`. It cannot cause a spend nobody saw.
- **Slippage is not visible in the same way.** It is a number nobody would
  notice changing, and a page that could raise it could have every later trade
  sandwiched.

So `settings.setPresets` is page-allowed and reaches only the active profile's
amounts; slippage is carried through untouched from storage and stays
popup-only. The edit runs through exactly the validator a popup edit does, so a
page cannot store a value the user could not have typed.

**The panel redraws from what was stored, not from what was typed.** The
validator trims and can refuse, and the buttons have to show what a click will
actually spend.

**A real bug caught by a leaking test.** Saving wrote straight into
`options.profiles` — the caller's array — so an edit silently changed what every
later panel built from that object would draw. It was found because one test's
save appeared in the next test's assertions, which is precisely the shape the
production failure would have taken. The panel now copies the profiles it is
given.
