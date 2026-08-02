# @hoodini/harness

Node CLI for exercising `VenueAdapter` implementations without the extension —
quote a token, dump the resolved venue, print the calldata a buy *would* send.

**Status: placeholder (P0).** `src/` is empty; built in **P1a** alongside the
first adapter.

The harness is read-only by construction. It may quote and it may build and
simulate calldata via `eth_call`; it has no signer and no broadcast path, and it
will not grow one — live sends are the extension's job, gated on `LIVE_TRADING`.

```bash
pnpm --filter @hoodini/harness start
```
