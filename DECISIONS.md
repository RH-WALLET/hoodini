# nock — DECISIONS

Append-only log. Each entry: what was decided, why, and what would reverse it.
Decisions marked **PENDING RORY** are proposals only and must not be built on.

---

### D-001 — pnpm + Turborepo monorepo, TypeScript strict everywhere
**Decided.** `apps/extension`, `apps/harness`, `packages/core`, `packages/adapters`.

The extension and a Node harness must share the exact trade-path code — if the
harness tested a reimplementation, its green result would prove nothing about
what the extension ships. A workspace makes `@nock/core` one artifact consumed
by both. Matches the layout already used in `~/Projects/trenches`.

Strict mode plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`:
this codebase manipulates `bigint` wei amounts and addresses, where a silently
`undefined` field is a wrong-amount bug, not a crash.

*Reversed by:* the extension bundler proving unable to consume workspace TS
sources directly (would move `@nock/core` to a built `dist`).

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

### D-007 — Census finding: Pons is an instant-pool venue, not a bonding curve
**Recorded fact, drives sequencing.**

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

### D-009 — Router selection for the Uniswap adapter — **PENDING, resolve in P1a**
Two verified `UniversalRouter` deployments and several unnamed contracts carry
real trades for the same pool. Multiple `SwapRouter02` and `QuoterV2`
deployments exist on this chain, and name is not evidence — several bind to
*different* V3 factories.

Rule adopted now: a router or quoter is only usable once its `factory()` has
been confirmed equal to the pool's factory. The census resolved `QuoterV2`
`0x238ECf69…` this way. The equivalent binding for the swap router is P1a work.

---

### D-010 — VERIFIED vs UNCONFIRMED, and what may be traded against
**Decided.** Every address in DATA_SOURCES.md carries a status. Only **VERIFIED**
entries — confirmed on-chain by `scripts/recon.ts` this session — may ever be
used to build a transaction. UNCONFIRMED entries are leads.

Harvested notes are treated as untrusted input and re-derived on chain. This
caught a real drift: flap.sh's Portal implementation is now
`0x7Bc20c2C…`, not the `0xd9C9981D…` recorded three weeks ago. An adapter that
had trusted the note would be encoding against a replaced implementation.
