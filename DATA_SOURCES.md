# Hoodini — DATA_SOURCES

The census. Every address Hoodini might ever call, with its evidence and status.

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
RH Chain as its parent. It is not a Hoodini target.

## 2. Core infrastructure

| Contract | Address | Status |
|---|---|---|
| WETH (pair token) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | VERIFIED — `pairToken()` of a live Pons token |
| Uniswap V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | VERIFIED — `dexFactory()` of a live Pons token |
| **SwapRouter02 (the V3 swap path)** | `0xCaf681a66D020601342297493863E78C959E5cb2` | VERIFIED — `factory()` → `0x1f7d7550…` **and** `WETH9()` → `0x0Bd7D308…`; carries the Pons operator's own `multicall` trades |
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

**flap.sh** — VERIFIED end to end (2026-08-03)

> ⚠ **CORRECTION.** An earlier pass listed `buy(address,address,uint256)` and
> `sell(address,uint256,uint256)` as flap's trade surface, on the strength of
> the ABI. Reading the deployed source shows **both bodies are
> `revert FeatureDisabled()`** — they are dead entry points. An adapter written
> from the ABI alone would have compiled, reviewed cleanly, and failed for every
> user. The live path is `swapExactInput`.

| Item | Value |
|---|---|
| Portal (proxy) | `0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09` |
| Implementation | `Portal` `0x7Bc20c2C5A25649b0A765B7E4d7d11E3e1A9fA06` (already drifted once) |
| Trade | `swapExactInput({inputToken, outputToken, inputAmount, minOutputAmount, permitData})` payable |
| Quote | `quoteExactInput({inputToken, outputToken, inputAmount})` — nonpayable, eth_call only |
| State / membership | `getTokenV9Safe(token)` — **reverts** for a non-flap token |
| Native asset | `address(0)` on either side; no recipient param, output goes to `msg.sender` |
| Approval | plain ERC-20 to the Portal (`permitData` empty) — no Permit2 here |

`getTokenV9Safe` returns `status`, `reserve`, `price`, `quoteTokenAddress`,
`pool`, `progress`, `buyTaxRate`, `sellTaxRate`, `bondingCurveFeeRate`.

**Live sample** `0x59b3ae7570Ca4ce4ad110DC1D0D3a12Fc5d17777` (a `7777` tax
clone): status 1, native-ETH quoted, `pool = 0x0` (on curve), buy tax 1000 bps,
sell tax 1000 bps, curve fee 125 bps. Buy calldata **executes against live
state**; a full round trip at 0.0000001 ETH returned 79.2%, consistent with
11.25% each way plus impact.

**State is keyed on `pool`, not `status`** — a pool address only exists after
migration, which is directly observable, whereas the `status` enum is
undocumented in the verified source and no graduated flap token was found.

**Sell quotes can revert** with an arithmetic underflow when the amount exceeds
what the curve's reserve can pay out (selling 513k tokens into a 5.34e-7 ETH
reserve). Same UI consequence as D-021: gate the sell control on a successful
quote, never on holding a balance.

**Virtuals** — factory VERIFIED, trade path **NOT THIN — deferred**

`VirtualsBondingAdapter` exposes only `ASSET_TOKEN()`, `sellBase(...)` and
`sellQuote(...)` — callbacks used by another contract, not a user-facing trade
interface, and with no quote function. Unlike klik, Virtuals cannot be added as
a thin adapter: it needs its own recon into whatever contract actually holds its
bonding curve. Deferred rather than guessed at (D-042).

**Virtuals** — factory VERIFIED, trade path UNCONFIRMED
- `AgentFactoryV7`, with `executeBondingCurveApplicationSalt(...)` and
  `allTokens(uint256)` / `allTradingTokens(uint256)` enumeration.
- Sample token `0x401095…4cae` has **no AMM pool**. Trades route through
  `VirtualsBondingAdapter` `0xDeEF773D61719a3181E35e9281600Db8bA063f71`, with
  `PoolManager` `0x8366a39C…` (Uniswap V4) and `RobinHoodSettler`
  `0x1d4B86491ec211257cbedD77A4380a7494624EfF` also appearing as counterparties.
- **Open:** `VirtualsBondingAdapter` ABI, `claims()` read, quote method.

**klik.finance** — VERIFIED end to end (2026-08-03)

| Item | Value |
|---|---|
| Factory | `0x16cF6788B762EE8969744586eD16fc5705140dd7` |
| Hook | `UniversalKlikHook` `0x745d717620052a97a22dEEE2e5Eba59583f3e0CC` |
| Pool shape | **native ETH** paired (`address(0)`), fee **0**, tickSpacing **200** |
| `claims()` | `tokenInfoByAddress(token).token != address(0)` — a Pons token reads back an all-zero struct |
| Pool identity | **derived** from the token address, then verified against `getTokenPrice(token).poolId` |

**The pool key is constructed, not looked up.** Every klik pool uses fixed
parameters, so the `PoolKey` follows from the token address alone. That is only
safe because it is checked: hashing the constructed key gives a poolId, and klik
reports the poolId it actually uses. Verified live on
`0xf9b3ef2B…` — the constructed key, the `Initialize` event and `getTokenPrice`
all produced `0xa4d8acff…40be`. A mismatch makes the adapter refuse (D-041).

**Live:** 0.001 ETH → **984,779.65 tokens**; buy calldata executes against live
state. Sell quotes revert for this pool — the **third** venue to do so, after
Doppler and flap.

**Native-paired changes the write path.** klik settles straight from
`msg.value`; Doppler's WETH pools must `WRAP_ETH` first. Wrapping a native pool
would settle the wrong currency and revert, so the shared V4 encoder branches on
the numeraire rather than assuming one.

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

## 7. Relative venue size (on-chain, 2026-08-02)

All-time transaction counts against each launchpad's own contract. **Not
apples-to-apples** — read the caveat before ranking on it.

| Launchpad | Factory txs | Token transfers | What the number means |
|---|---|---|---|
| flap.sh | 274,100 | 2,925,450 | launches **+ every buy/sell** (trading lives on the Portal) |
| Pons V1 | 237,829 | 951,965 | **launches only** — trading happens on Uniswap pools, not the factory |
| NOXA | 93,431 | 240,736 | legacy; launching disabled since 2026-07-11 |
| klik.finance | 8,877 | 17,222 | launches + V4 activity |
| Virtuals (proxy) | 14 | 310 | agent deploys route elsewhere; proxy itself barely touched |

Because Pons trades settle on Uniswap rather than the factory, Pons's *launch*
count is far higher relative to flap than these totals suggest, and its true
trading volume is invisible here entirely. Public reporting puts Pons at ~80% of
RH Chain launchpad volume and >50% of all chain transactions (UNCONFIRMED —
external source, not measured on-chain).

### Pons V2 — investigated exhaustively, NOT FOUND on-chain

Public reporting (~2026-07-27) says Pons V2 ships an **ETH bonding curve**,
**Uniswap V4**, and **RWA pairs**. Four independent on-chain searches were run to
locate it. None found it. As of block **26,029,100** its contracts are not
identifiable on-chain.

| Method | Result |
|---|---|
| Explorer name search (`Pons`, `PonsV2`, `PonsBonding`, `PonsCurve`) | Only copycat memecoins squatting the name |
| Interface sweep — 59 factory-shaped contracts probed for the Pons ABI (`pnpm factories`) | 9 live factories, **all Uniswap V3, none with a curve or V4 config** |
| Traffic ranking — 400 blocks, 4,915 txs (`pnpm discover`) | Top destinations are `SwapRouter02` and MEV bots; no Pons V2 |
| Uniswap V4 hook census — 1,711 pool inits (`pnpm v4-hooks`) | Doppler, Pump, Clanker, klik, LaunchHook, FriarTier — **no Pons hook** |

RWA pairs *do* exist on V4 (`HOOD/USDG`, `HANSOME/NVDA` observed), but the pools
carry no hook, so they are not attributable to a Pons V2 launchpad.

**Conclusion:** either V2 has not deployed yet despite the announcements, or it
is deployed unverified under a name none of these four methods surfaces. This is
a supported negative result, not an unexplored gap. Re-run `pnpm factories` and
`pnpm v4-hooks` to re-check; supplying a V2 address or tx hash resolves it in one
`pnpm recon` run.

### The Pons family — 9 factories, one adapter

The Pons/NOXA factory interface has been cloned repeatedly. Every clone declares
the **same** DEX config, so one adapter covers all of them.

| Factory | Launch fee | Txs | Status |
|---|---|---|---|
| `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (**Pons V1**, the real one) | 0.0005 ETH | 238,340 | VERIFIED |
| `0x78A3613eac99d072EFFd3e07feC462Da28b67F54` `LaunchFactory` | 0.00016 ETH | 207 | VERIFIED |
| `0x7A8dB326E50A6e8CBc0616E0636B63737b5E84c8` `PonsLaunchFactory` | 0.0001 ETH | 14 | VERIFIED |
| `0x75eCa6306fFA2d6A66Ad841072CF6E805f0D35A7` `PonsLaunchFactory` | 0.0001 ETH | 9 | VERIFIED |
| `0x966ffA3957a6d3621D3EfC96E22160806f0EF141` `PonsLaunchFactory` | 0.0005 ETH | 9 | VERIFIED |
| `0xce9BA2D14F320627F177ABE20885C6363f012634` `LaunchFactory` | 0.0005 ETH | 7 | VERIFIED |
| `0xf830DA401D45494129b8ED844744F08296557a97` `LaunchFactory` | 0.0005 ETH | 6 | VERIFIED |
| `0xB8e6519b16BFc4487Ed931DaCb6Fb739e1d7e008` `PonsLaunchFactory` | **0 ETH** | 6 | VERIFIED |
| `0x9eCb03CED43dc1e10aC07d268E3dd5c00349b947` `LaunchFactory` | 0.0005 ETH | 3 | VERIFIED |

The clones are fee-undercutting forks with negligible traction. V1 carries
essentially all the volume. `claims()` becomes a set membership test:
`token.launchFactory() ∈ {these 9}`.

### Pons launch config, read from the factory itself

`getLaunchConfig(0)` and `getDexConfig(0)` on Pons V1 — the protocol's own
declared parameters, not inferred:

| Field | Value |
|---|---|
| pairToken | WETH `0x0Bd7D308…` |
| **graduationThreshold** | **4.2 ETH** |
| initialTick | -204200 |
| supply | 1,000,000,000 × 1e18 |
| maxWalletBps / maxTxBps | 500 (5%) / 550 |
| restrictionBlocks | 2 |
| dex | `uniswap v3`, factory `0x1f7d7550…`, **swapRouter `0xCaf681a6…`**, positionManager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`, poolFee 10000, tickSpacing 200 |

**This is the strongest possible confirmation of D-009**: the factory itself
names `SwapRouter02 0xCaf681a6…` as its router. It also corrects the census's
first pass — Pons *does* have a graduation threshold (4.2 ETH). The curve is
implemented as a single-sided concentrated V3 position rather than a separate
curve contract, so **buy/sell is a V3 swap in both states** and one adapter
covers pre- and post-graduation alike.

### Graduated Pons token — VERIFIED end to end (2026-08-03)

Supplied by Rory to test for Pons V2. It is **V1** — but it is the first
confirmed *graduated* token, which settles how `state()` and the post-graduation
trade path work.

| Field | Value |
|---|---|
| Token | `0xB84e494158976B4e14da155d1cdaE16EB6D1C477` — Kolana 🐨 |
| Contract | `PonsLauncherToken`, `v0.8.30` (identical to V1) |
| `launchFactory()` | `0xA5aAb3F0…` — **Pons V1** |
| Pool | `0xac2e451a6b141a0b2b2d9fd746fff4724491db5e`, WETH pair, fee 10000 |
| **`graduationStatus()`** | `[raised, threshold=4.2 ETH, graduated]` — **live, reversible**, see below |
| Live quote | 2026-08-03 07:xx → 30,111.072 Kolana · same day later → 723,850.206 Kolana |

**`graduationStatus(address)` returns a 3-tuple `(raised, threshold, graduated)`**
— that is the `state()` implementation for the Pons adapter, and it costs one
static call.

`getLaunchedToken(address)` returns a full struct — `deployer`, `pairedToken`,
`positionManager`, `positionId`, `dexId`, `poolFee`, `supply`,
`restrictionsEndBlock`, `initialBuyAmount`, and an `exists` flag.

**The decisive result:** a graduated token still quotes through the *same*
`QuoterV2` and the *same* V3 pool as a pre-graduation one. Graduation moves the
liquidity position; it does not move the venue. One Uniswap V3 adapter therefore
covers Pons tokens in **both** states — now proven against a graduated token,
not just assumed.

Also of note: `initialBuyAmount` is 4.2 ETH, exactly the graduation threshold —
the deployer graduated the token at launch in a single buy. Worth handling as a
normal case, not an edge case.

**CORRECTION (later the same day): `graduated` is reversible.** Re-reading the
same token hours later returned `raised = 0.0055 ETH, graduated = false`, down
from `5.32 ETH / true`. `raised` is the pool's **live WETH reserve**, not a
cumulative total — corroborated directly against the pool, which held
`0.005508 ETH` (the ~1.6e-6 gap is accrued LP fees) and **995,956,029 of the
1,000,000,000 supply**. Holders sold nearly everything back.

So `graduationStatus.graduated` is a running comparison of reserve against
threshold, **not a latched migration event**. Consequences:

- `state()` must never be cached and must never gate anything irreversible.
- A token can read `graduated` on one call and `curve` on the next with no
  contract state having "un-migrated".
- This does not affect trade correctness, because the trade path does not branch
  on state (D-016) — the same pool, router and quoter serve both readings. The
  architecture absorbing this cleanly is the point.

It also makes the venue's real behaviour legible: Pons "graduation" is a
liquidity-depth threshold on a single-sided V3 position, not a migration.

## 7b. Uniswap V4 launch venues, by hook

From 1,711 `Initialize` events on PoolManager `0x8366a39C…` over ~200k blocks
(`pnpm v4-hooks`). On V4 the hook identifies the launchpad.

| Pools | Hook | Venue |
|---|---|---|
| 324 | `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` | `DopplerHookInitializer` — **largest V4 launch venue on the chain; absent from the original census** |
| 96 | `0x5Cf8e499C7c466C7E2cf127BDF129F57151E65Dc` | `PositionManager` |
| 14 | `0x14bcC18fDB0e7a427122b9C2F1A40fF7D63EAACC` | `PumpV4Hook` |
| 13 | `0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc` | `ClankerHookStaticFeeV2` |
| 6 | `0x35b59db64335C22840d98Be894B8F3E1e2EfD080` | `FriarTier` |
| 5 | `0x745d717620052a97a22dEEE2e5Eba59583f3e0CC` | `UniversalKlikHook` — confirms klik.finance runs on V4 |
| 4 | `0x778b0c4EeA7D35D66513B587bA87FC9084b0EaCC` | `LaunchHook` |
| 1,157 | `0x0000…0000` | no hook — plain V4 pools |

All VERIFIED as live hooks; none of their trade interfaces are decoded yet.
**Doppler is a genuine census gap** — 324 pools in 5.5 hours, and it did not
appear in the seed corpus at all.

### Doppler — VERIFIED read path (2026-08-03)

The largest Uniswap V4 launch venue on the chain, and structurally unlike every
other venue in this census: **there is no launch factory and no curve contract.**
The launchpad *is* a V4 hook, so the hook is simultaneously the attribution
source, the state oracle, and the thing that prices each swap.

| Item | Address | Status |
|---|---|---|
| `DopplerHookInitializer` | `0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544` | VERIFIED — verified source, 14,176 txs, 3.84M transfers |
| Airlock | `0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862` | VERIFIED — `hook.airlock()` |
| V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | VERIFIED — `hook.poolManager()` |
| **V4Quoter (pinned)** | `0x218AfB5850b862580A60eEA20AA4d5FA4400ae41` | VERIFIED — `poolManager()` binds; returned a live quote |

**Attribution and state** come from one call: `getState(asset)` returns
`(numeraire, reserves, beneficiary, extra, status, PoolKey)`. A non-Doppler
token reads back a zero struct rather than reverting, so a zero numeraire is the
discriminator.

`enum PoolStatus { Uninitialized, Initialized, Locked, Graduated, Exited }` —
read from the hook's **verified source**, not inferred from observed values.
Initialized/Locked are the auction (`curve`); Graduated/Exited mean liquidity
migrated out (`graduated`).

> ⚠ **UNCONFIRMED:** every live Doppler asset observed reads `Locked`, and there
> were **no `Graduate` events in 200k blocks**. The Graduated/Exited mappings are
> reasoned from the enum, not witnessed on-chain.

**Quote path VERIFIED:** 0.001 ETH → **18,099,829.240759115810680497 OKC**
(`0x8B18800B…`), identical across all four bound quoters.

**Dynamic fees.** Every Doppler pool carries `fee = 8388608` (`0x800000`), V4's
`DYNAMIC_FEE_FLAG`. `PoolKey.fee` is a marker, not a rate — the hook sets the
real fee per swap. `Quote.feeBps` is therefore `null` for these pools; the fee is
already inside `amountOut`.

**The numeraire is not always WETH.** One observed pool paired against
`0xad25Ac6C…`. An adapter assuming WETH would silently quote the wrong direction,
so the numeraire is always read from the hook.

### Doppler write path — VERIFIED by simulation (2026-08-03)

| Contract | Address | Status |
|---|---|---|
| **UniversalRouter (pinned)** | `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77` | VERIFIED — constructor args wire it to **our** Permit2, WETH, V3 factory and V4 PoolManager |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | VERIFIED — constructor arg [0] of the router |

> ⚠ **The other bound router (`0x8876789976…`) is a FORK**: `COMMAND_TYPE_MASK`
> is `0x7f` instead of `0x3f` and it adds `executeSigned`. Upstream Uniswap
> constants are therefore **not** automatically correct on this chain — every
> command, action and struct below was read out of the pinned router's verified
> source (D-020).

**Buy** — `WRAP_ETH(ADDRESS_THIS, ethIn)` → `V4_SWAP[SWAP_EXACT_IN_SINGLE,
SETTLE(WETH, ethIn, payerIsUser=false), TAKE_ALL(asset, minOut)]`.
`payerIsUser=false` is what makes a buy Permit2-free.

**Sell** — `V4_SWAP[SWAP_EXACT_IN_SINGLE, SETTLE_ALL(asset, amountIn),
TAKE(WETH, ADDRESS_THIS, OPEN_DELTA)]` → `UNWRAP_WETH(MSG_SENDER, minOut)`.
Slippage is enforced on the unwrap, where the user's ETH actually lands.

**Proof.** Both were executed against live state via `eth_call`:

| Simulation | Result |
|---|---|
| Buy, sender funded by state override | ✅ **executes** |
| Sell, token balance only | ❌ reverts |
| Sell, balance **+ Permit2 allowance** overridden | ✅ **executes** |

The middle row matters: it proves the Permit2 grant is genuinely required, so
`approvalNeeded`'s two-step flow is not speculative. Balance overrides needed the
Solady slot recipe (`keccak256(owner ++ 8 zero bytes ++ uint32(0x87a211a2))`) —
Doppler tokens are EIP-1167 clones of `DopplerERC20V1`, which is Solady-based, so
linear storage slots do not work.

### ⚠ Doppler sells can be unavailable — product-critical

Sells revert on **3 of 4** sampled `Locked` pools, at *every* size including 1
token, while buys succeed at every size. The quoter surfaces it as
`UnexpectedRevertBytes(bytes)` (`0x6190b2b0`) — a wrapper meaning something
reverted underneath it.

| Token | status | buy | sell |
|---|---|---|---|
| `0x8B18800B…` | Locked | ✅ | ❌ |
| `0x48452389…` | Locked | ✅ | ❌ |
| `0x224e5A04…` | Locked | ✅ | ✅ |
| `0xD08D4382…` | Locked | ✅ | ❌ |

It is **not** a protocol-wide "no sells during the auction" rule — one Locked
pool sells fine — so the cause is per-pool and **UNCONFIRMED** (most likely
one-sided liquidity while the auction is still distributing). This is not a bug
in the adapter: the same encoding sells successfully on the pool that permits it.

**The UI must quote before offering a sell** and show "cannot sell right now"
when the quote reverts. Rendering a sell button that always fails would be worse
than not rendering one.

### Routers — a trap worth recording

**Every contract merely *named* `UniversalRouter` on this chain binds to a
different PoolManager.** All four name-search hits point at foreign V4
deployments. The two routers that actually carry traffic — `0x53BF6B06…` and
`0x8876789976…` — expose no `factory()` (which is why the V3 census could not
validate them) but **do** expose `poolManager()`, and both bind correctly.

| Candidate | Binds to our PoolManager? |
|---|---|
| 4× `V4Quoter` | ✅ all four |
| 1 of 3 `StateView` (`0xF3334192…`) | ✅ |
| 4× named `UniversalRouter` | ❌ none — all foreign |
| `0x53BF6B06…`, `0x8876789976…` (real traffic) | ✅ both |

**The V4 write path is NOT verified.** It needs UniversalRouter
`execute(commands, inputs)` encoding plus Permit2 approvals, neither yet checked
against deployed source. Deferred to P1b-2 (D-018).

## 8. Overlay targets (terminals and screeners)

Where Hoodini's buttons get injected. Status = whether RH Chain support is
confirmed. None of these are DOM-verified yet — that needs the P3 snapshot.

| Target | URL | RH Chain | Notes |
|---|---|---|---|
| **Axiom** | `axiom.trade` | VERIFIED (external) | **CONFIRMED BY RORY as the P3 target.** First major terminal on RH Chain, integrated ~2026-07-11. Bloom overlays it. Still needs a DOM snapshot for adapter design. |
| **GMGN** | `gmgn.ai` | VERIFIED (external) | ~10 chains incl. Robinhood. Charges 1%. Bloom overlays it. |
| **DexScreener** | `dexscreener.com` | VERIFIED (external) | 670 links in Rory's own alert corpus. Screener, not a competitor. |
| **GeckoTerminal** | `geckoterminal.com` | VERIFIED (external) | 670 links in the alert corpus. |
| **Blockscout** | `robinhoodchain.blockscout.com` | VERIFIED | 670 links in the corpus; also our explorer API. |
| **BasedBot** | `basedbot.tech` | LIKELY | Multi-chain EVM terminal. The alert corpus Rory scraped is *emitted by* BasedBot and labels Pons launches — strong evidence of RH coverage. |
| **Nock Terminal** | `nockterminal.com` | VERIFIED (external) | **Name collision — see D-012.** RH-native screener + NockBot (1% fee) + launchpad. Competitor, not an overlay target. |
| **Terminal (ex-Padre)** | `trade.padre.gg` | UNCONFIRMED | Multi-chain, acquired by the Pump.fun team. RH support not confirmed. Bloom overlays it. |
| **Banana Gun** | `bananagun.io` | VERIFIED (external) | Telegram bot, RH Chain from day one. Telegram surface, not a web terminal. |
| **Photon / BullX Neo / J7Tracker** | — | UNCONFIRMED | Bloom overlays these; RH Chain support unverified. |

**Competitor positioning:** Bloom already supports Robinhood Chain and overlays
Axiom, Terminal, GMGN, DexScreener, Photon and J7Tracker. So the overlay surface
is not the wedge — 0%, non-custodial, and no backend are.

## 9. Open items for the pause gate

1. **Terminal target** — which terminal(s) to overlay first, plus a saved DOM
   snapshot. Nothing here yet.
2. **Launchpad ranking** — Rory's must-have v1 list, checked against §3.
3. **Live CAs** for flap.sh, klik and Virtuals — ideally one pre-graduation and
   one graduated each, so their curve and DEX paths can both be pinned. The seed
   corpus contained none for flap or klik.
4. **`eth_subscribe`** — re-test, or accept polling.
