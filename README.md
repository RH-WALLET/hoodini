# Hoodini

A 0% non-custodial trading overlay for **Robinhood Chain**. A Chrome MV3
extension that puts quick buy/sell buttons directly on the pages you already
watch — trading terminals, X, Telegram Web.

> **Status: P0.** Scaffold, interfaces, and chain recon only. There is no trade
> engine, no wallet, and **no send path of any kind** in this repo yet.

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
apps/extension/     MV3 + Vite + CRXJS + React      (P2)
apps/harness/       Node CLI for adapter testing    (P1a)
packages/core/      chain client, keystore, trade engine, VenueAdapter/Router
packages/adapters/  SiteAdapter interface + per-site adapters (P3/P4)
scripts/recon.ts    read-only launchpad census
```

## Getting started

```bash
pnpm install
cp .env.example .env
```

Run the chain census (read-only — no signer, no transactions):

```bash
pnpm recon
```

## Safety

`DRY_RUN=true` and `LIVE_TRADING=false` are the defaults everywhere, and any
future send path re-checks `LIVE_TRADING` at the last possible moment before
broadcast. The full, permanent invariant list is in
[CLAUDE.md](CLAUDE.md).

## Docs

| File | What's in it |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Working protocol and the non-negotiable security invariants |
| [BUILD-PLAN.md](BUILD-PLAN.md) | Phases P0 → P5 with status |
| [DECISIONS.md](DECISIONS.md) | D-001… — what was decided and why |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process diagram, both interfaces, keystore lifecycle, buy/sell paths |
| [DATA_SOURCES.md](DATA_SOURCES.md) | The census: every launchpad, factory, router, marked VERIFIED or UNCONFIRMED |

The project token is launched and managed manually, entirely outside this
repository. No code here touches token issuance.
