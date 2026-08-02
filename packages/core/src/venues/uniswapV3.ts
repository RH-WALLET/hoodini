/**
 * Uniswap V3 adapter — the settlement venue for the whole Pons/NOXA corpus.
 *
 * Pons tokens are Uniswap V3 pools from the moment they launch, and graduation
 * relocates the liquidity position without relocating the venue (D-016). So a
 * single adapter trades them in both states, and `state()` is display
 * information that does not branch the trade path.
 *
 * Read-only: every method either reads or returns UNSIGNED calldata. Nothing
 * here can sign or broadcast.
 */

import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import {
  ERC20_ABI,
  PONS_FACTORY_ABI,
  PONS_TOKEN_ABI,
  QUOTER_V2_ABI,
  SWAP_ROUTER_02_ABI,
  UNISWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI,
  MSG_SENDER,
  ADDRESS_THIS,
} from '../abis.js';
import {
  PONS_FACTORIES,
  QUOTER_V2,
  SWAP_ROUTER_02,
  UNISWAP_V3_FACTORY,
  V3_FEE_TIERS,
  WETH,
} from './registry.js';
import type { Quote, TokenRef, TxRequest, VenueAdapter, VenueState } from './types.js';

/** Where a token's liquidity lives, once resolved. */
interface PoolRef {
  readonly pool: Address;
  readonly fee: number;
}

const BPS = 10_000n;

/** Deadline for the router's multicall. Wall-clock, so it is passed in, not read. */
const DEFAULT_DEADLINE_SECONDS = 300n;

export interface UniswapV3AdapterOptions {
  /** Injected so tests and the harness can pin time; defaults to now. */
  readonly now?: () => number;
}

export class UniswapV3Adapter implements VenueAdapter {
  readonly id = 'uniswap-v3';

  readonly #client: PublicClient;
  readonly #now: () => number;
  /** token -> pool. Memoised: resolution costs up to 4 calls, trading repeats. */
  readonly #pools = new Map<string, PoolRef | null>();

  constructor(client: PublicClient, options: UniswapV3AdapterOptions = {}) {
    this.#client = client;
    this.#now = options.now ?? (() => Date.now());
  }

  // ── resolution ────────────────────────────────────────────────────────────

  /**
   * Find the token's WETH pool. Pons tokens name their own pool and fee, which
   * is one call and exact; everything else falls back to probing fee tiers on
   * the V3 factory.
   */
  async #resolvePool(token: TokenRef): Promise<PoolRef | null> {
    const key = token.address.toLowerCase();
    const cached = this.#pools.get(key);
    if (cached !== undefined) return cached;

    let found: PoolRef | null = null;

    // Fast path: the token tells us directly.
    try {
      const [pool, fee] = await Promise.all([
        this.#client.readContract({ address: token.address, abi: PONS_TOKEN_ABI, functionName: 'liquidityPool' }),
        this.#client.readContract({ address: token.address, abi: PONS_TOKEN_ABI, functionName: 'poolFee' }),
      ]);
      if (pool && !isAddressEqual(pool, zeroAddress)) found = { pool: getAddress(pool), fee: Number(fee) };
    } catch {
      // Not a Pons-family token; fall through.
    }

    // General path: ask the factory, most-likely fee tier first.
    if (!found) {
      for (const fee of V3_FEE_TIERS) {
        try {
          const pool = await this.#client.readContract({
            address: UNISWAP_V3_FACTORY,
            abi: UNISWAP_V3_FACTORY_ABI,
            functionName: 'getPool',
            args: [token.address, WETH, fee],
          });
          if (pool && !isAddressEqual(pool, zeroAddress)) {
            found = { pool: getAddress(pool), fee };
            break;
          }
        } catch {
          // try the next tier
        }
      }
    }

    // A pool that exists but holds nothing cannot be traded against.
    if (found) {
      try {
        const liquidity = await this.#client.readContract({
          address: found.pool,
          abi: UNISWAP_V3_POOL_ABI,
          functionName: 'liquidity',
        });
        if (liquidity === 0n) found = null;
      } catch {
        found = null;
      }
    }

    this.#pools.set(key, found);
    return found;
  }

  /** The Pons-family factory that launched this token, if any. */
  async #launchFactory(token: TokenRef): Promise<Address | null> {
    try {
      const factory = await this.#client.readContract({
        address: token.address,
        abi: PONS_TOKEN_ABI,
        functionName: 'launchFactory',
      });
      return factory ? getAddress(factory) : null;
    } catch {
      return null;
    }
  }

  // ── VenueAdapter ──────────────────────────────────────────────────────────

  async claims(token: TokenRef): Promise<boolean> {
    return (await this.#resolvePool(token)) !== null;
  }

  /**
   * Pons publishes graduation directly. For anything else with a V3 pool there
   * is no curve to be on, so it is already graduated by definition.
   *
   * ⚠ `graduated` is NOT a latched event. `raised` is the pool's live WETH
   * reserve, so the flag is a running comparison against the threshold and can
   * flip back when holders sell out — observed on Kolana, which read
   * `graduated=true` at 5.32 ETH and `false` at 0.0055 ETH a day later.
   *
   * Never cache this, and never let it gate anything irreversible. It is
   * display information: the trade path is identical either way (D-016).
   */
  async state(token: TokenRef): Promise<VenueState> {
    const factory = await this.#launchFactory(token);
    if (!factory) return (await this.claims(token)) ? 'graduated' : 'unknown';

    const known = PONS_FACTORIES.some((f) => isAddressEqual(f, factory));
    if (!known) return (await this.claims(token)) ? 'graduated' : 'unknown';

    try {
      const [, , graduated] = await this.#client.readContract({
        address: factory,
        abi: PONS_FACTORY_ABI,
        functionName: 'graduationStatus',
        args: [token.address],
      });
      return graduated ? 'graduated' : 'curve';
    } catch {
      return 'unknown';
    }
  }

  async quoteBuy(token: TokenRef, ethIn: bigint): Promise<Quote> {
    return this.#quote(token, WETH, token.address, ethIn);
  }

  async quoteSell(token: TokenRef, amountIn: bigint): Promise<Quote> {
    return this.#quote(token, token.address, WETH, amountIn);
  }

  async #quote(token: TokenRef, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote> {
    assertPositive(amountIn);
    const poolRef = await this.#requirePool(token);

    // simulateContract == eth_call. QuoterV2 reverts internally to return its
    // result, so this can never be broadcast.
    const { result } = await this.#client.simulateContract({
      address: QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn, tokenOut, amountIn, fee: poolRef.fee, sqrtPriceLimitX96: 0n }],
    });
    const [amountOut] = result;

    return {
      venueId: this.id,
      state: await this.state(token),
      amountIn,
      amountOut,
      // QuoterV2 gives no reference price, and deriving one from slot0 would be
      // a different number than the fill. Reporting null beats reporting a guess.
      priceImpactBps: null,
      feeBps: poolRef.fee / 100,
      source: 'simulation',
    };
  }

  /**
   * Buy: native ETH in, tokens out.
   *
   * `msg.value` funds the swap — the router wraps it because tokenIn is WETH —
   * and `refundETH` returns any dust in the same transaction. The recipient is
   * the MSG_SENDER sentinel, so the tokens go to whoever signs.
   */
  async buildBuy(token: TokenRef, ethIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(ethIn);
    assertSlippage(slippageBps);
    const poolRef = await this.#requirePool(token);
    const { amountOut } = await this.quoteBuy(token, ethIn);
    const minOut = applySlippage(amountOut, slippageBps);

    const swap = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: WETH,
          tokenOut: token.address,
          fee: poolRef.fee,
          recipient: MSG_SENDER,
          amountIn: ethIn,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const refund = encodeFunctionData({ abi: SWAP_ROUTER_02_ABI, functionName: 'refundETH' });

    return {
      to: SWAP_ROUTER_02,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_02_ABI,
        functionName: 'multicall',
        args: [this.#deadline(), [swap, refund]],
      }),
      value: ethIn,
      description: `Buy ${token.symbol ?? token.address} — ${ethIn} wei ETH in, min ${minOut} out (${slippageBps} bps)`,
    };
  }

  /**
   * Sell: tokens in, native ETH out.
   *
   * The swap sends WETH to the router (ADDRESS_THIS) and `unwrapWETH9` then
   * pays ETH to msg.sender. Slippage is enforced on the unwrap rather than the
   * swap — that is where the user-visible ETH amount is checked, so a partial
   * fill cannot slip past it.
   */
  async buildSell(token: TokenRef, amountIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(amountIn);
    assertSlippage(slippageBps);
    const poolRef = await this.#requirePool(token);
    const { amountOut } = await this.quoteSell(token, amountIn);
    const minOut = applySlippage(amountOut, slippageBps);

    const swap = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: token.address,
          tokenOut: WETH,
          fee: poolRef.fee,
          recipient: ADDRESS_THIS,
          amountIn,
          amountOutMinimum: 0n, // enforced by unwrapWETH9 below
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const unwrap = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: 'unwrapWETH9',
      args: [minOut],
    });

    return {
      to: SWAP_ROUTER_02,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_02_ABI,
        functionName: 'multicall',
        args: [this.#deadline(), [swap, unwrap]],
      }),
      value: 0n,
      description: `Sell ${token.symbol ?? token.address} — ${amountIn} wei in, min ${minOut} wei ETH out (${slippageBps} bps)`,
    };
  }

  /**
   * The router pays with `transferFrom(msg.sender, ...)`, so a sell needs an
   * allowance to the router. Approves the exact amount rather than unlimited:
   * an exact allowance caps the blast radius if the router is ever compromised.
   */
  async approvalNeeded(token: TokenRef, owner: Address, amountIn: bigint): Promise<TxRequest | null> {
    assertPositive(amountIn);
    const allowance = await this.#client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, SWAP_ROUTER_02],
    });
    if (allowance >= amountIn) return null;

    return {
      to: token.address,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [SWAP_ROUTER_02, amountIn] }),
      value: 0n,
      description: `Approve ${amountIn} wei of ${token.symbol ?? token.address} to SwapRouter02`,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async #requirePool(token: TokenRef): Promise<PoolRef> {
    const poolRef = await this.#resolvePool(token);
    if (!poolRef) throw new Error(`uniswap-v3: no liquid WETH pool for ${token.address}`);
    return poolRef;
  }

  #deadline(): bigint {
    return BigInt(Math.floor(this.#now() / 1000)) + DEFAULT_DEADLINE_SECONDS;
  }
}

/**
 * Zero is the router's CONTRACT_BALANCE flag — it would swap the router's whole
 * balance of the token rather than nothing. Reject it before it can be encoded.
 */
function assertPositive(amount: bigint): void {
  if (amount <= 0n) throw new Error('amount must be > 0 (0 is the router CONTRACT_BALANCE flag)');
}

function assertSlippage(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error(`slippageBps out of range: ${bps}`);
}

/**
 * Minimum acceptable output. Rounds down, so the on-chain check is never looser
 * than the slippage the user chose.
 *
 * There is no fee term here, and there is not meant to be one: the 0% platform
 * fee is a product invariant (CLAUDE.md invariant 6). `amountOut` is what the
 * pool returns and `minOut` is only reduced by the user's own slippage.
 */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * (BPS - BigInt(slippageBps))) / BPS;
}
