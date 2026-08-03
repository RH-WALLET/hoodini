# Contributing

## The one rule that matters

**Never trust an ABI.** Read the deployed verified source before encoding a call
against a contract. This has bitten this project twice: two different venues
advertised functions in their ABI whose bodies were `revert FeatureDisabled()`.
An adapter written from the ABI compiles, reviews cleanly, and fails for every
user.

## Working practice

- `pnpm test` and `pnpm typecheck` must be green before a commit.
- Read `CLAUDE.md`, `DECISIONS.md`, `ARCHITECTURE.md` and `DATA_SOURCES.md`
  before proposing a change. The decisions log explains *why* things are the way
  they are, including several that look redundant and are not.
- New addresses go in `DATA_SOURCES.md` marked VERIFIED (confirmed on-chain) or
  UNCONFIRMED. Only VERIFIED addresses may be used to build a transaction.

## Testing

Tests are offline and deterministic. They run against stub clients, never the
live chain — a suite that read live pool state would go red when a token dumps,
which is a market event and not a regression.

**Mutation-check anything that guards money or a security boundary.** Break the
code on purpose and confirm the suite goes red:

```bash
# 1. make the change you want to prove is caught
# 2. pnpm test   -> must fail
# 3. revert      -> must pass
```

This has found four real gaps in this codebase, and in three of them the *test*
was wrong rather than the code. A test that has never failed has not been shown
to work.

## Adding a venue

1. Recon first: read the deployed source, confirm the trade entry point is live.
2. Implement `VenueAdapter` in `packages/core/src/venues/`.
3. Add a registry entry with VERIFIED addresses.
4. Prove the built calldata executes with `eth_call` against live state — state
   overrides are fine for balances and allowances.
5. Tests, then mutation-check them.

## Adding a site adapter

Prefer stable hooks (`data-testid`) over class names, which are minified and
change without warning. Always leave the shape-based fallback in place so a
stale selector degrades precision instead of removing the overlay.

## Security

See `SECURITY.md`. Do not open a public issue for anything that could put funds
at risk.
