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
