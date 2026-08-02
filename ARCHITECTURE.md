# nock — ARCHITECTURE

Three processes, one trust boundary. The page is hostile, the service worker is
the only place a key exists, and nothing in between is a server.

---

## 1. Overall shape

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ PAGE  (x.com · web.telegram.org · terminal · dexscreener)               │
 │                                                                         │
 │  ┌───────────────────────────────────────────────────────────────────┐  │
 │  │ CONTENT SCRIPT — one SiteAdapter per matched URL                  │  │
 │  │   detectTokens(document) → TokenRef[]                             │  │
 │  │   findAnchors(tokenRef)  → Element[]                              │  │
 │  │   mount(anchor, tokenRef)                                         │  │
 │  │                                                                   │  │
 │  │   DOM only. No keys. No RPC. No calldata. Sees no balances.       │  │
 │  └───────────────────────────────────────────────────────────────────┘  │
 └──────────────────────────────────┬──────────────────────────────────────┘
                                    │  chrome.runtime message
                                    │  { quote | trade | status }  — a REQUEST,
                                    │  never a signature request
        ═══════════════════ TRUST BOUNDARY ═══════════════════
                                    │
 ┌──────────────────────────────────▼──────────────────────────────────────┐
 │ SERVICE WORKER  (extension origin)                                      │
 │                                                                         │
 │   ┌──────────────┐   ┌─────────────────┐   ┌──────────────────────┐     │
 │   │  KEYSTORE    │   │  TRADE ENGINE   │   │     VenueRouter      │     │
 │   │  unlock/lock │──▶│  quote → build  │──▶│  registry → claims() │     │
 │   │  in-memory   │   │  → sign → send  │   └──────────┬───────────┘     │
 │   │  key only    │   │  ▲ LIVE_TRADING │              │                 │
 │   └──────────────┘   │    checked HERE │   ┌──────────▼───────────┐     │
 │                      └─────────────────┘   │   VenueAdapter[]     │     │
 │                                            │  uniswap-v3 · pons   │     │
 │                                            │  flap · virtuals · … │     │
 │                                            └──────────┬───────────┘     │
 └───────────────────────────────────────────────────────┼─────────────────┘
                                                         │
                                    ┌────────────────────▼─────────────────┐
                                    │ PUBLIC RPC  (Robinhood Chain, 4663)  │
                                    │ + public explorer API. No backend.   │
                                    └──────────────────────────────────────┘
```

`POPUP / OPTIONS` talks to the service worker over the same message channel:
wallet create/import, unlock, settings, positions.

---

## 2. The two interfaces

### `SiteAdapter` — `packages/adapters/src/site.ts`

```ts
id: string
siteMatch: URLPattern
detectTokens(document: Document): TokenRef[]
findAnchors(tokenRef: TokenRef): Element[]
mount(anchor: Element, tokenRef: TokenRef): void
```

One per supported site. Pure DOM. Addresses scraped from a page are untrusted
input: validated as checksummed addresses, then resolved on-chain before
anything is displayed or traded. `mount` must be idempotent — SPA re-renders
call it repeatedly against the same node.

### `VenueAdapter` — `packages/core/src/venues/types.ts`

```ts
id: string
claims(token): Promise<boolean>                              // cheap membership check
state(token): Promise<'curve' | 'graduated' | 'unknown'>
quoteBuy(token, ethIn): Promise<Quote>
buildBuy(token, ethIn, slippageBps): Promise<TxRequest>
quoteSell(token, amountIn): Promise<Quote>
buildSell(token, amountIn, slippageBps): Promise<TxRequest>
approvalNeeded(token, owner, amountIn): Promise<TxRequest | null>
```

`build*` returns an **unsigned** `TxRequest`. Adapters never sign, never
broadcast, and never see a key. Adding a launchpad is one new file implementing
this interface plus one registry entry — nothing above the interface changes.

---

## 3. Keystore lifecycle

```
   create ──┐                                  ┌── export (password re-entry,
            │                                  │    explicit confirm, one-shot
   import ──┤                                  │    reveal, never logged)
            ▼                                  │
      ┌───────────┐   password    ┌──────────┐ │
      │  LOCKED   │──────────────▶│ UNLOCKED │─┘
      │           │   scrypt KDF  │          │
      │ ciphertext│               │ key in   │
      │ at rest in│◀──────────────│ SW memory│
      │ storage   │  lock():      │ only     │
      │ .local    │  zero memory, └──────────┘
      └───────────┘  drop handle        │
            ▲                           │
            └───── auto-lock timer ─────┘
                   (also on SW teardown, which is involuntary in MV3)
```

- **create** — key generated in-extension via WebCrypto. Never derived from,
  or sent to, anything off-device.
- **at rest** — AES-GCM ciphertext + salt + IV + KDF params in
  `chrome.storage.local`. The plaintext key is never written to any storage.
- **unlock** — password → scrypt → AES-GCM decrypt → key lives in
  service-worker memory only.
- **lock** — on timer, on explicit request, and implicitly whenever MV3 tears
  the worker down. Teardown is normal, so unlock state must always be
  reconstructible from a password and never assumed.
- **export** — requires password re-entry and an explicit confirmation.

---

## 4. Buy path

```
 user clicks BUY on an anchor
        │
        ▼
 content script → SW:  { buy, token, ethIn, slippageBps }
        │
        ▼
 VenueRouter.resolve(token)
        │
        ├─ 1. TOKEN_VENUE_OVERRIDES       ── bundled, exact match
        ├─ 2. registry factory attribution ── bundled
        └─ 3. claims() across adapters     ── runtime fallback, 1 cheap call each
        │
        ├─ no adapter claims it ──▶ "unsupported venue", stop. Never guess a router.
        ▼
 adapter.state(token)
        │
        ├── 'curve'     ──▶ adapter.quoteBuy  → curve math / venue view fn
        └── 'graduated' ──▶ adapter.quoteBuy  → QuoterV2 via eth_call
        │
        ▼
 adapter.buildBuy(token, ethIn, slippageBps) → unsigned TxRequest
        │
        ▼
 confirm sheet: amountOut, minOut after slippage, venue fee, gas
        │                            (nock's own fee is 0 and has no code path)
        ▼
 keystore unlocked? ── no ──▶ prompt unlock
        │ yes
        ▼
 ┌──────────────────────────────────────────────┐
 │  if (!LIVE_TRADING) → simulate and stop      │  ← last possible moment
 └──────────────────────────────────────────────┘
        │
        ▼
 sign in SW memory → eth_sendRawTransaction → watch receipt
```

Buys are native-ETH in, so no approval is involved.

## 5. Sell path

Same resolution, plus allowance and nonce handling:

```
 adapter.approvalNeeded(token, owner, amountIn)
        │
        ├─ returns TxRequest ──▶ approve first, wait for receipt, then continue
        │                        (exact amount, not unlimited)
        └─ returns null      ──▶ straight to the swap
        ▼
 adapter.buildSell(token, amountIn, slippageBps) → unsigned TxRequest
        ▼
 same confirm → LIVE_TRADING gate → sign → send
```

**Nonce management.** The service worker serialises all sends behind a single
in-flight lock per account and reads the pending nonce immediately before
signing. Approve-then-swap is two sequential transactions, so the swap's nonce
depends on the approval having landed; they are never built in parallel. MV3 can
tear the worker down mid-flight, so an in-flight send is recorded before
broadcast and reconciled on wake — never blind-resent.
