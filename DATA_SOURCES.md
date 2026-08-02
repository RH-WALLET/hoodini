# nock — DATA_SOURCES

The census. Every address nock might ever call, with its evidence and status.

- **VERIFIED** — confirmed on-chain by `scripts/recon.ts` on **2026-08-02** at
  block **26,005,121**.
- **UNCONFIRMED** — harvested from notes or observed but not fully pinned down.
  A lead. **Never build a transaction against an UNCONFIRMED address** (D-010).

Reproduce with `pnpm recon`. Raw output: `scripts/out/census.json` (gitignored).

---

## 1. Chain

| Item | Value | Status |
|---|---|---|
| Chain | Robinhood Chain (Arbitrum Orbit L2) | VERIFIED |
| chainId | `4663` | VERIFIED — `eth_chainId` → `0x1237` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | VERIFIED |
| Explorer | `https://robinhoodchain.blockscout.com` (Blockscout v2 REST, no key) | VERIFIED |
| Latest block at census | `26,005,121` @ 2026-08-02T15:23:24Z | VERIFIED |
| Mean block time | `0.100 s/block` over 1,000 blocks | VERIFIED |
| Gas price | `0.020538 gwei` (20,538,000 wei) | VERIFIED |
| WebSocket / `eth_subscribe` | **Not supported** — HTTP POST only. Poll. | UNCONFIRMED (from `printer/RECON.md`, not re-tested this session) |

**Do not confuse with Fork in Hood.** `~/Projects/fork-in-hood` is Rory's *own*
Orbit chain (`chainId 36754663`, `https://rpc.forkinhood.com`) which settles to
RH Chain as its parent. It is not a nock target.

## 2. Core infrastructure

| Contract | Address | Status |
|---|---|---|
| WETH (pair token) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | VERIFIED — `pairToken()` of a live Pons token |
| Uniswap V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | VERIFIED — `dexFactory()` of a live Pons token |
| **QuoterV2 (bound to that factory)** | `0x238ECf693467381E6402AD7d7833880FfeA33D88` | VERIFIED — its `factory()` equals the pool's factory, and it returned a live quote |
| QuoterV2 (second, same factory) | `0x0269F8b86bB3C1e927DaCEDb72f3463Ef6D26F61` | VERIFIED binding; unused |
| Uniswap V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | VERIFIED — the shared V4 counterparty for klik and Virtuals tokens |

> **Name is not evidence on this chain.** Search returns ≥5 contracts named
> `QuoterV2`, ≥5 named `SwapRouter02`, ≥4 named `UniversalRouter`, and they bind
> to *different* V3 factories (e.g. `0x3edfd1e4…` → factory `0xba04837d…`, not
> ours). Every router/quoter must be confirmed via `factory()` before use (D-009).

## 3. Launchpad census

Method: 74 real token CAs harvested from `tg-ca-relay/backtest_targets.json`
(2026-07-20 → 07-23) traced to their deploying contract via Blockscout
`creator_address_hash`, then each factory re-read on-chain.

| Launchpad | Factory | Seed tokens | Source | Launch gate | Model | Status |
|---|---|---|---|---|---|---|
| **Pons** | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | **72 / 74** | verified, non-upgradeable, Solidity 0.8.30 | `launchEnabled = true`, `launchFee = 0.0005 ETH` | **instant Uniswap V3 pool — no curve** | VERIFIED |
| **Virtuals** | `0x43E4C17b15365596Caae8e7d00E42Bc8E988c2d4` (proxy) → `AgentFactoryV7` `0xF0a8089da19568a37bCCacc4BFE3A2a9f1E71675` | 2 / 74 | verified, EIP-1967 proxy | — | bonding curve → Uniswap V4 | VERIFIED (factory) / UNCONFIRMED (trade path) |
| **flap.sh** | `0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09` (proxy) → `Portal` `0x7Bc20c2C5A25649b0A765B7E4d7d11E3e1A9fA06` | 0 / 74 | verified, EIP-1967 proxy | — | **true bonding curve** — `buy`/`sell` on the Portal | VERIFIED (interface) / UNCONFIRMED (quote path) |
| **klik.finance** | `0x16cF6788B762EE8969744586eD16fc5705140dd7` | 0 / 74 | verified, non-upgradeable, Solidity 0.8.35 | `deployCoinEnabled = true` | Uniswap V4 + hooks | VERIFIED (factory) / UNCONFIRMED (trade path) |
| **NOXA Fun** | `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB` | 0 / 74 | **NOT source-verified** | **`launchEnabled = false`** | instant V3 (legacy tokens still trade) | UNCONFIRMED |

**NOXA is still shut.** Launching was disabled 2026-07-11 and remains disabled
three weeks later. Its existing tokens trade on Uniswap V3, so the P1a adapter
covers them without any NOXA-specific code.

**flap.sh drifted.** The Portal implementation is now `0x7Bc20c2C…`; the
harvested note recorded `0xd9C9981D…`. It is an upgradeable proxy behind a
1-of-3 Gnosis Safe, so its interface can change again without warning — an
adapter must assert the implementation at load (D-010).

### Per-launchpad trade surface

**Pons** — VERIFIED end to end
- Factory functions: `launchToken`, `getLaunchedToken(address)`,
  `graduationStatus(address)`, `launchEnabled()`, `launchFee()`. **No buy/sell.**
- Token getters: `launchFactory()`, `liquidityPool()`, `pairToken()`,
  `poolFee()`, `dexFactory()`, `positionManager()`.
- **`claims()`** → `token.launchFactory() == 0xA5aAb3F0…` — one static call on the
  token, no factory state. Evidence: `0xc6a672…c82b.launchFactory()` → `0xA5aAb3…1feB`.
- **`state()`** → always `graduated`. Pons tokens are V3 pools from launch.
- **Quote** → `QuoterV2.quoteExactInputSingle` via `eth_call`.
  Live result: **0.001 ETH → 715,650.919168300349914631 tokens**, 0 ticks
  crossed, gas estimate 94,271. Pool `0x23154F6D765225Eb81Cd5550c0175D5a5E9a59B8`,
  WETH pair, fee tier 10000 (1%), in-range liquidity 3.68e22.

**flap.sh** — interface VERIFIED, quote path UNCONFIRMED
- `buy(address,address,uint256) payable` · `sell(address,uint256,uint256)` ·
  `buyOnCreation(address,address,uint256) payable` · `buyQuotaOf(address,address)` ·
  `swapExactInput(tuple) payable` · `swapExactInputV3(tuple) payable`
- Graduation surface: `TokenMigratorSet`, `TaxOnBondingCurvePaid` events.
- Sample token found: `0x645b23…7777` — the `7777` suffix corroborates the
  mined-vanity tax-clone scheme in `printer/RECON-flap.md`.
- **Open:** no view quoter located; `buyQuotaOf` needs decoding, and the
  curve-vs-graduated signal needs pinning. P1b work.

**Virtuals** — factory VERIFIED, trade path UNCONFIRMED
- `AgentFactoryV7`, with `executeBondingCurveApplicationSalt(...)` and
  `allTokens(uint256)` / `allTradingTokens(uint256)` enumeration.
- Sample token `0x401095…4cae` has **no AMM pool**. Trades route through
  `VirtualsBondingAdapter` `0xDeEF773D61719a3181E35e9281600Db8bA063f71`, with
  `PoolManager` `0x8366a39C…` (Uniswap V4) and `RobinHoodSettler`
  `0x1d4B86491ec211257cbedD77A4380a7494624EfF` also appearing as counterparties.
- **Open:** `VirtualsBondingAdapter` ABI, `claims()` read, quote method.

**klik.finance** — factory VERIFIED, trade path UNCONFIRMED
- `getTokenPrice(address)` view · `tokenInfoByAddress(address)` ·
  `deployedTokens(uint256)` · `getAllTokensByCreator(address)` · `POOL_MANAGER()`.
- Sample token `0x2c2a0Abe6AE007217c3D1e3F42D668A2AaD36D4f` has no V3/V2 pool; its
  counterparty is `PoolManager` `0x8366a39C…` → Uniswap **V4**.
- **`claims()`** candidate: `factory.tokenInfoByAddress(token)` — not yet confirmed
  to return an emptiness-distinguishable value for a non-klik token.
- **Open:** V4 quoting requires a V4 quoter or `PoolManager` simulation, not
  `QuoterV2`.

## 4. Routers observed carrying real trades

Derived from actual swap transactions against a live Pons pool — these are
addresses users demonstrably route through, not name matches.

| Address | Explorer name | Source | Status |
|---|---|---|---|
| `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77` | UniversalRouter | verified | VERIFIED as a live trade entrypoint; `factory()` binding not yet checked |
| `0x8876789976dEcBfCbBbe364623C63652db8C0904` | UniversalRouter | verified | VERIFIED as a live trade entrypoint; `factory()` binding not yet checked |
| `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | PositionManager | verified | LP plumbing, not a swap path |
| `0x7483cdbEB0A3aADA8929e4DAbc970B23284B15b9` | (unnamed) | unverified | UNCONFIRMED — likely an aggregator or MEV bot |
| `0x114d574247342eafea95b7a9234e62984d48cD9E` | (unnamed) | unverified | UNCONFIRMED |
| `0x6F6F5E1b4669C2e1553E65e6162D9E60172bb7Fe` | (unnamed) | unverified | UNCONFIRMED |
| `0x4A86009A36FceC5Aa341ffCEB3205a911FcF6f60` | (unnamed) | unverified | UNCONFIRMED |

Choosing between the two `UniversalRouter`s is P1a work (D-009).

## 5. Provenance of harvested inputs

| Source | Used for | Trust |
|---|---|---|
| `~/Projects/printer/RECON.md`, `LAUNCHPAD-SURVEY.md`, `RECON-flap.md` | RPC, chainId, factory candidates, WETH, DEX factory, flap internals | Re-derived on-chain; one item (flap impl) had drifted |
| `~/Projects/printer/pons-abi.json`, `factory-abi.json` | Pons verified ABI; reconstructed NOXA ABI | Pons re-fetched from the explorer this session |
| `~/Projects/tg-ca-relay/backtest_targets.json` | The 74 seed token CAs | Public addresses; every one re-traced on-chain |
| `~/Projects/fork-in-hood` | Confirmed RH Chain is the *parent* of Rory's own chain | Context only |
| `~/Projects/trenches` | Monorepo conventions | Style only |

No wallet, key, or `.env` secret was read from any sibling repo.

## 6. Open items for the pause gate

1. **Terminal target** — which terminal(s) to overlay first, plus a saved DOM
   snapshot. Nothing here yet.
2. **Launchpad ranking** — Rory's must-have v1 list, checked against §3.
3. **Live CAs** for flap.sh, klik and Virtuals — ideally one pre-graduation and
   one graduated each, so their curve and DEX paths can both be pinned. The seed
   corpus contained none for flap or klik.
4. **`eth_subscribe`** — re-test, or accept polling.
