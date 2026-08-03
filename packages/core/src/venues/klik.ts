/**
 * klik.finance adapter — Uniswap V4, native-ETH paired.
 *
 * The thinnest venue in the project, because its pool identity is derivable.
 * klik launches every token into a V4 pool with fixed parameters — fee 0,
 * tickSpacing 200, its own hook, paired against native ETH — so the PoolKey can
 * be *constructed* from the token address alone rather than looked up.
 *
 * That construction is then **verified against the chain**: hashing the key
 * gives a poolId, and klik's own `getTokenPrice` returns the poolId it uses. If
 * the two disagree the adapter refuses rather than trading against a pool it
 * guessed (D-041). Confirmed live — constructed key, the `Initialize` event and
 * `getTokenPrice` all produced the same id.
 */

import { encodeFunctionData, getAddress, keccak256, encodeAbiParameters, parseAbiParameters, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { ERC20_ABI, KLIK_FACTORY_ABI, PERMIT2_ABI, V4_QUOTER_ABI } from '../abis.js';
import { KLIK_FACTORY, KLIK_HOOK, PERMIT2, UNIVERSAL_ROUTER, V4_QUOTER } from './registry.js';
import type { PoolKey } from './doppler.js';
import type { Quote, TokenRef, TxRequest, VenueAdapter, VenueState } from './types.js';
import { applySlippage } from './uniswapV3.js';
import { encodeV4Buy, encodeV4Sell } from './v4.js';

/** Every klik pool uses these. Verified against live pools and their poolIds. */
export const KLIK_POOL_FEE = 0;
export const KLIK_TICK_SPACING = 200;

const DEADLINE_SECONDS = 300n;
const PERMIT2_EXPIRY_SECONDS = 1_800n;

/** V4 requires currency0 < currency1. Native (address(0)) always sorts first. */
export function klikPoolKey(token: Address): PoolKey {
  const a = zeroAddress.toLowerCase();
  const b = token.toLowerCase();
  const [c0, c1] = a < b ? [zeroAddress, token] : [token, zeroAddress];
  return {
    currency0: getAddress(c0),
    currency1: getAddress(c1),
    fee: KLIK_POOL_FEE,
    tickSpacing: KLIK_TICK_SPACING,
    hooks: KLIK_HOOK,
  };
}

/** Uniswap V4's pool id: keccak of the abi-encoded key. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('(address,address,uint24,int24,address)'), [
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ]),
  );
}

export class KlikAdapter implements VenueAdapter {
  readonly id = 'klik';

  readonly #client: PublicClient;
  readonly #factory: Address;
  readonly #quoter: Address;
  readonly #now: () => number;

  constructor(
    client: PublicClient,
    options: { factory?: Address; quoter?: Address; now?: () => number } = {},
  ) {
    this.#client = client;
    this.#factory = options.factory ?? KLIK_FACTORY;
    this.#quoter = options.quoter ?? V4_QUOTER;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * `tokenInfoByAddress` returns a zero struct for anything klik did not
   * launch — verified against a Pons token, which reads back all zeroes. So a
   * non-zero token field is the membership test, in one call.
   */
  async claims(token: TokenRef): Promise<boolean> {
    try {
      const info = (await this.#client.readContract({
        address: this.#factory,
        abi: KLIK_FACTORY_ABI,
        functionName: 'tokenInfoByAddress',
        args: [token.address],
      })) as unknown as readonly [Address, ...unknown[]];
      return !isAddressEqual(getAddress(info[0]), zeroAddress);
    } catch {
      return false;
    }
  }

  /**
   * klik launches straight into a live V4 pool — there is no curve phase to be
   * on — so a token it knows is tradeable immediately.
   */
  async state(token: TokenRef): Promise<VenueState> {
    return (await this.claims(token)) ? 'graduated' : 'unknown';
  }

  /**
   * Construct the key, then prove it. Refusing on mismatch is the point: a key
   * built from assumed constants that silently drifted would quote and trade
   * against the wrong pool.
   */
  async #verifiedKey(token: TokenRef): Promise<PoolKey> {
    const key = klikPoolKey(token.address);
    const expected = poolIdOf(key);
    const price = (await this.#client.readContract({
      address: this.#factory,
      abi: KLIK_FACTORY_ABI,
      functionName: 'getTokenPrice',
      args: [token.address],
    })) as unknown as readonly [Hex, ...unknown[]];

    if (String(price[0]).toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `klik: pool id mismatch for ${token.address} — constructed ${expected}, chain says ${String(price[0])}`,
      );
    }
    return key;
  }

  async quoteBuy(token: TokenRef, ethIn: bigint): Promise<Quote> {
    return this.#quote(token, ethIn, true);
  }

  async quoteSell(token: TokenRef, amountIn: bigint): Promise<Quote> {
    return this.#quote(token, amountIn, false);
  }

  async #quote(token: TokenRef, amountIn: bigint, buying: boolean): Promise<Quote> {
    assertPositive(amountIn);
    const key = await this.#verifiedKey(token);
    // Native sorts first, so buying is currency0 -> currency1.
    const zeroForOne = buying === isAddressEqual(key.currency0, zeroAddress);

    const { result } = await this.#client.simulateContract({
      address: this.#quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    });

    return {
      venueId: this.id,
      state: 'graduated',
      amountIn,
      amountOut: (result as unknown as readonly [bigint, bigint])[0],
      priceImpactBps: null,
      quoteAsset: null, // native ETH
      // klik's pools carry fee 0 in the key and charge through the hook
      // instead, so no fixed rate is correct here — the cost is inside
      // amountOut. Null rather than a misleading zero.
      feeBps: null,
      source: 'simulation',
    };
  }

  async buildBuy(token: TokenRef, ethIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(ethIn);
    assertSlippage(slippageBps);
    const key = await this.#verifiedKey(token);
    const { amountOut } = await this.quoteBuy(token, ethIn);
    const minOut = applySlippage(amountOut, slippageBps);

    const call = encodeV4Buy({
      poolKey: key,
      numeraire: zeroAddress,
      token: token.address,
      amountIn: ethIn,
      minOut,
      deadline: this.#deadline(),
    });
    return { ...call, description: `Buy ${token.symbol ?? token.address} — ${ethIn} wei ETH in, min ${minOut} out (${slippageBps} bps)` };
  }

  async buildSell(token: TokenRef, amountIn: bigint, slippageBps: number): Promise<TxRequest> {
    assertPositive(amountIn);
    assertSlippage(slippageBps);
    const key = await this.#verifiedKey(token);
    const { amountOut } = await this.quoteSell(token, amountIn);
    const minOut = applySlippage(amountOut, slippageBps);

    const call = encodeV4Sell({
      poolKey: key,
      numeraire: zeroAddress,
      token: token.address,
      amountIn,
      minOut,
      deadline: this.#deadline(),
    });
    return { ...call, description: `Sell ${token.symbol ?? token.address} — ${amountIn} wei in, min ${minOut} wei ETH out (${slippageBps} bps)` };
  }

  /**
   * Same two-step Permit2 flow as any V4 sell: the UniversalRouter pulls the
   * token through Permit2, so an ERC-20 allowance to the router alone is not
   * enough. Buys need nothing — they are paid in native ETH.
   */
  async approvalNeeded(token: TokenRef, owner: Address, amountIn: bigint): Promise<TxRequest | null> {
    assertPositive(amountIn);

    const erc20 = await this.#client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, PERMIT2],
    });
    if (erc20 < amountIn) {
      return {
        to: token.address,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, amountIn] }),
        value: 0n,
        description: `Step 1 of 2 — approve ${amountIn} wei of ${token.symbol ?? token.address} to Permit2`,
      };
    }

    const [amount, expiration] = await this.#client.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [owner, token.address, UNIVERSAL_ROUTER],
    });
    const nowSec = BigInt(Math.floor(this.#now() / 1000));
    if (BigInt(amount) >= amountIn && BigInt(expiration) > nowSec) return null;

    return {
      to: PERMIT2,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [token.address, UNIVERSAL_ROUTER, amountIn, Number(nowSec + PERMIT2_EXPIRY_SECONDS)],
      }),
      value: 0n,
      description: `Step 2 of 2 — allow UniversalRouter to spend ${amountIn} wei via Permit2 (expires in 30 min)`,
    };
  }

  #deadline(): bigint {
    return BigInt(Math.floor(this.#now() / 1000)) + DEADLINE_SECONDS;
  }
}

function assertPositive(amount: bigint): void {
  if (amount <= 0n) throw new Error('amount must be > 0');
}

function assertSlippage(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error(`slippageBps out of range: ${bps}`);
}
