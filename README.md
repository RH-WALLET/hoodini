# Hoodini

A 0% non-custodial trading overlay for **Robinhood Chain**. A Chrome MV3
extension that puts quick buy/sell buttons directly on the pages you already
watch — trading terminals, X, Telegram Web.

> **Status: P5.** Working extension — wallet, four venues, site overlays,
> positions. The send path exists but is **off**: `LIVE_TRADING` is a build-time
> constant defaulting to false, so a normal build cannot broadcast.

## Why it exists

The incumbent (Bloom) charges ~1%, executes on its own servers, and requires an
account. Hoodini inverts all three:

| | Bloom | Hoodini |
|---|---|---|
| Platform fee | ~1% | **0%** |
| Keys | server-side | **never leave your device** |
| Backend | required | **none** |
| Account | required | none |
| Source | closed | open |

Venue-agnostic by design: every RH Chain launchpad and Uniswap sits behind one
`VenueAdapter` interface, so a token is tradeable regardless of where it was
launched.

## Layout

```
apps/extension/     MV3 + Vite + CRXJS + React — popup, worker, content script
apps/harness/       Node CLI: resolve a CA, quote it, print + simulate calldata
packages/core/      chain client, keystore, venue adapters, trade planner
packages/adapters/  site adapters, overlay, DOM runtime
scripts/            read-only recon: census, discovery, V4 hooks, DOM capture
docs/landing/       landing page (token CA display)
```

## Venues

| Venue | Model | Status |
|---|---|---|
| Uniswap V3 | DEX — settles the whole Pons/NOXA corpus | quote + trade |
| Pons (9 factories) | instant V3 pool | quote + trade |
| Doppler | Uniswap V4 bonding curve | quote + trade |
| flap.sh | bonding curve via Portal | quote + trade |

Sites: Axiom, GMGN and Terminal *(all DOM-verified; each mixes chains, so only
Robinhood Chain rows are decorated)*, X, Telegram Web and DexScreener
*(selectors written blind, with shape-based fallback)*, plus a generic adapter
for any page showing raw addresses.

## Getting started

```bash
pnpm install
cp .env.example .env
```

Run the chain census (read-only — no signer, no transactions):

```bash
pnpm recon
```

## Try it

```bash
pnpm install
pnpm --filter @hoodini/extension build
```

Then `chrome://extensions` → Developer mode → **Load unpacked** →
`apps/extension/dist`.

Or drive the venues from the CLI, read-only:

```bash
pnpm --filter @hoodini/harness start 0xB84e494158976B4e14da155d1cdaE16EB6D1C477 0.001 100
```

## Safety

`LIVE_TRADING` is a **build-time** constant, default false — a released build
cannot be persuaded to broadcast by anything at runtime. Going live is a
deliberate rebuild:

```bash
VITE_LIVE_TRADING=true pnpm --filter @hoodini/extension build
```

The first live trade is capped at 0.005 ETH. See [SECURITY.md](SECURITY.md) for
the threat model, including what is explicitly *not* defended.

## Docs

| File | What's in it |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Working protocol and the non-negotiable security invariants |
| [BUILD-PLAN.md](BUILD-PLAN.md) | Phases P0 → P5 with status |
| [DECISIONS.md](DECISIONS.md) | D-001… — what was decided and why |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process diagram, both interfaces, keystore lifecycle, buy/sell paths |
| [DATA_SOURCES.md](DATA_SOURCES.md) | The census: every launchpad, factory, router, marked VERIFIED or UNCONFIRMED |
| [SECURITY.md](SECURITY.md) | Threat model — what is defended, and what is not |
| [PRIVACY.md](PRIVACY.md) | What is stored (locally) and sent (nothing) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Working practice, including why ABIs are not trusted |

The project token is launched and managed manually, entirely outside this
repository. No code here touches token issuance; `docs/landing/` only displays a
contract address once one exists.

---

**Hoodini Finance is not affiliated with, endorsed by, or connected to Robinhood
Markets, Inc.** It trades on Robinhood Chain, a public blockchain.

MIT licensed. Trading is risky; you can lose everything.
