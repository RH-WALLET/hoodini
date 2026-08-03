/**
 * Doppler adapter — V4 read and write paths.
 *
 * Write-path assertions decode the UniversalRouter calldata and check the
 * command bytes, action bytes and each action's parameters. Comparing hex would
 * pass while encoding something entirely different.
 */

import { describe, expect, it } from 'vitest';
import { getAddress, zeroAddress, type Address } from 'viem';
import { DopplerAdapter } from '../src/venues/doppler.js';
import { DOPPLER_HOOK, V4_QUOTER, WETH } from '../src/venues/registry.js';
import { DOPPLER_POOL_STATUS, V4_DYNAMIC_FEE_FLAG } from '../src/abis.js';
import { createStubClient } from './stubClient.js';
import type { TokenRef } from '../src/venues/types.js';

const TOKEN = getAddress('0x8B18800B8D7991aeAF8A7D8F10d34F06eA811bA3');
const token: TokenRef = { address: TOKEN, chainId: 4663 };

/** getState tuple: [numeraire, reserves, beneficiary, extra, status, poolKey] */
function stateTuple(status: number, opts: { numeraire?: Address; fee?: number; currency0?: Address } = {}) {
  const numeraire = opts.numeraire ?? WETH;
  const currency0 = opts.currency0 ?? numeraire;
  return [
    numeraire,
    85_000_000n * 10n ** 18n,
    getAddress('0x9982538F41f2ae29ddb9d3D9307010052984FDbB'),
    '0x',
    status,
    {
      currency0,
      currency1: currency0 === numeraire ? TOKEN : numeraire,
      fee: opts.fee ?? V4_DYNAMIC_FEE_FLAG,
      tickSpacing: 200,
      hooks: DOPPLER_HOOK,
    },
  ];
}

function adapterWith(state: unknown, amountOut = 18_099_829n * 10n ** 18n) {
  const { client, calls } = createStubClient({
    reads: { [`${DOPPLER_HOOK.toLowerCase()}.getState`]: state },
    simulates: { [`${V4_QUOTER.toLowerCase()}.quoteExactInputSingle`]: [amountOut, 963_521n] },
  });
  return { adapter: new DopplerAdapter(client), calls };
}

describe('claims', () => {
  it('claims a live Doppler asset', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    expect(await adapter.claims(token)).toBe(true);
  });

  it('rejects a token the hook does not know', async () => {
    // Uninitialized reads back as a zero struct rather than reverting, so the
    // zero numeraire is the actual discriminator.
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Uninitialized, { numeraire: zeroAddress }));
    expect(await adapter.claims(token)).toBe(false);
  });

  it('rejects a token with a numeraire set but status still Uninitialized', async () => {
    // The zero-numeraire case above short-circuits before the status check ever
    // runs, so it does not exercise the status guard at all. This one does:
    // numeraire is a real address and only `status` says the pool is not live.
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Uninitialized));
    expect(await adapter.claims(token)).toBe(false);
  });

  it('rejects when the hook read reverts entirely', async () => {
    const { client } = createStubClient({ reads: {} });
    expect(await new DopplerAdapter(client).claims(token)).toBe(false);
  });
});

describe('state — maps Doppler PoolStatus', () => {
  it.each([
    [DOPPLER_POOL_STATUS.Initialized, 'curve'],
    [DOPPLER_POOL_STATUS.Locked, 'curve'],
    [DOPPLER_POOL_STATUS.Graduated, 'graduated'],
    [DOPPLER_POOL_STATUS.Exited, 'graduated'],
  ])('status %i -> %s', async (status, expected) => {
    const { adapter } = adapterWith(stateTuple(status));
    expect(await adapter.state(token)).toBe(expected);
  });

  it('is unknown for a token the hook does not track', async () => {
    const { adapter } = adapterWith(stateTuple(0, { numeraire: zeroAddress }));
    expect(await adapter.state(token)).toBe('unknown');
  });

  it('re-reads rather than caching — status advances during the auction', async () => {
    const { adapter, calls } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    await adapter.state(token);
    await adapter.state(token);
    expect(calls.filter((c) => c.endsWith('.getState'))).toHaveLength(2);
  });
});

describe('quotes', () => {
  it('quotes a buy through the bound V4 quoter', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    const q = await adapter.quoteBuy(token, 10n ** 15n);
    expect(q.venueId).toBe('doppler');
    expect(q.amountOut).toBe(18_099_829n * 10n ** 18n);
    expect(q.source).toBe('simulation');
  });

  it('reports a dynamic fee as null, never a sentinel or a fake zero', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    const q = await adapter.quoteBuy(token, 10n ** 15n);
    // A negative or zero placeholder would silently poison downstream maths.
    expect(q.feeBps).toBeNull();
  });

  it('converts a static fee tier to bps when the pool has one', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked, { fee: 10_000 }));
    expect((await adapter.quoteBuy(token, 1n)).feeBps).toBe(100);
  });

  it('rejects a zero amount', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    await expect(adapter.quoteBuy(token, 0n)).rejects.toThrow(/> 0/);
  });

  it('refuses to quote a token that is not a Doppler asset', async () => {
    const { adapter } = adapterWith(stateTuple(0, { numeraire: zeroAddress }));
    await expect(adapter.quoteBuy(token, 1n)).rejects.toThrow(/not a Doppler asset/);
  });

  it('uses the numeraire from the hook, which is not always WETH', async () => {
    // One observed pool used a non-WETH numeraire, so assuming WETH would
    // silently quote the wrong direction.
    const other = getAddress('0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4');
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked, { numeraire: other, currency0: other }));
    expect(await adapter.numeraire(token)).toBe(other);
  });

  it('exposes the PoolKey the write path will need', async () => {
    const { adapter } = adapterWith(stateTuple(DOPPLER_POOL_STATUS.Locked));
    const key = await adapter.poolKey(token);
    expect(key?.hooks).toBe(DOPPLER_HOOK);
    expect(key?.tickSpacing).toBe(200);
  });
});

// ── write path (P1b-2) ──────────────────────────────────────────────────────

import { decodeAbiParameters, parseAbiParameters, decodeFunctionData } from 'viem';
import { UNIVERSAL_ROUTER_ABI, UR_COMMANDS, V4_ACTIONS, PERMIT2_ABI } from '../src/abis.js';
import { UNIVERSAL_ROUTER, PERMIT2 } from '../src/venues/registry.js';

const NOW = () => 1_700_000_000_000;

function writeAdapter(state: unknown, amountOut = 1000n * 10n ** 18n, extraReads: Record<string, unknown> = {}) {
  const { client } = createStubClient({
    reads: { [`${DOPPLER_HOOK.toLowerCase()}.getState`]: state, ...extraReads },
    simulates: { [`${V4_QUOTER.toLowerCase()}.quoteExactInputSingle`]: [amountOut, 1n] },
  });
  return new DopplerAdapter(client, { now: NOW });
}

/** execute(commands, inputs, deadline) -> the pieces we care about. */
function decodeExecute(data: `0x${string}`) {
  const d = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data });
  const [commands, inputs, deadline] = d.args as readonly [`0x${string}`, readonly `0x${string}`[], bigint];
  const cmdBytes = (commands.slice(2).match(/.{2}/g) ?? []).map((h) => parseInt(h, 16));
  return { cmdBytes, inputs, deadline };
}

/** V4_SWAP input -> (actions[], params[]) */
function decodeV4(input: `0x${string}`) {
  const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), input) as [`0x${string}`, readonly `0x${string}`[]];
  return { actions: (actions.slice(2).match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)), params };
}

describe('buildBuy (V4)', () => {
  it('targets the pinned UniversalRouter and sends ETH as value', async () => {
    const tx = await writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked)).buildBuy(token, 10n ** 15n, 100);
    expect(tx.to).toBe(UNIVERSAL_ROUTER);
    expect(tx.value).toBe(10n ** 15n);
  });

  it('wraps ETH to the router, then swaps — WRAP_ETH before V4_SWAP', async () => {
    const tx = await writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked)).buildBuy(token, 10n ** 15n, 100);
    const { cmdBytes, inputs } = decodeExecute(tx.data);
    expect(cmdBytes).toEqual([UR_COMMANDS.WRAP_ETH, UR_COMMANDS.V4_SWAP]);

    const [recipient, amount] = decodeAbiParameters(parseAbiParameters('address, uint256'), inputs[0]!);
    // ADDRESS_THIS: the router must hold the WETH in order to settle with it.
    expect(recipient.toLowerCase()).toBe('0x0000000000000000000000000000000000000002');
    expect(amount).toBe(10n ** 15n);
  });

  it('settles from the ROUTER, not the user — this is what keeps buys Permit2-free', async () => {
    const tx = await writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked)).buildBuy(token, 10n ** 15n, 100);
    const { actions, params } = decodeV4(decodeExecute(tx.data).inputs[1]!);
    expect(actions).toEqual([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE, V4_ACTIONS.TAKE_ALL]);

    const [currency, amt, payerIsUser] = decodeAbiParameters(parseAbiParameters('address, uint256, bool'), params[1]!);
    expect(currency).toBe(WETH);
    expect(amt).toBe(10n ** 15n);
    expect(payerIsUser).toBe(false);
  });

  it('enforces slippage via TAKE_ALL minimum', async () => {
    const tx = await writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked)).buildBuy(token, 10n ** 15n, 100);
    const { params } = decodeV4(decodeExecute(tx.data).inputs[1]!);
    const [, minOut] = decodeAbiParameters(parseAbiParameters('address, uint256'), params[2]!);
    expect(minOut).toBe((1000n * 10n ** 18n * 9900n) / 10_000n);
  });

  it('refuses a non-WETH numeraire rather than building an impossible trade', async () => {
    const usdg = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
    const a = writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked, { numeraire: usdg, currency0: usdg }));
    await expect(a.buildBuy(token, 10n ** 15n, 100)).rejects.toThrow(/only supports WETH-paired/);
  });
});

describe('buildSell (V4)', () => {
  it('swaps then unwraps, sending no ETH', async () => {
    const tx = await writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked)).buildSell(token, 500n, 100);
    expect(tx.value).toBe(0n);
    const { cmdBytes } = decodeExecute(tx.data);
    expect(cmdBytes).toEqual([UR_COMMANDS.V4_SWAP, UR_COMMANDS.UNWRAP_WETH]);
  });

  it('settles the token from the USER — the Permit2 pull', async () => {
    const tx = await writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked)).buildSell(token, 500n, 100);
    const { actions, params } = decodeV4(decodeExecute(tx.data).inputs[0]!);
    expect(actions).toEqual([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE]);
    const [currency, maxAmount] = decodeAbiParameters(parseAbiParameters('address, uint256'), params[1]!);
    expect(currency).toBe(TOKEN);
    expect(maxAmount).toBe(500n);
  });

  it('keeps WETH in the router so it can be unwrapped to native ETH', async () => {
    const tx = await writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked)).buildSell(token, 500n, 100);
    const { params } = decodeV4(decodeExecute(tx.data).inputs[0]!);
    const [currency, recipient, amount] = decodeAbiParameters(parseAbiParameters('address, address, uint256'), params[2]!);
    expect(currency).toBe(WETH);
    expect(recipient.toLowerCase()).toBe('0x0000000000000000000000000000000000000002'); // ADDRESS_THIS
    expect(amount).toBe(0n); // OPEN_DELTA — "whatever the swap produced"
  });

  it('enforces slippage on the unwrap, where the user actually receives ETH', async () => {
    const tx = await writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked)).buildSell(token, 500n, 100);
    const { inputs } = decodeExecute(tx.data);
    const [recipient, minOut] = decodeAbiParameters(parseAbiParameters('address, uint256'), inputs[1]!);
    expect(recipient.toLowerCase()).toBe('0x0000000000000000000000000000000000000001'); // MSG_SENDER
    expect(minOut).toBe((1000n * 10n ** 18n * 9900n) / 10_000n);

    // The swap itself must NOT also enforce a minimum, or a partial fill could
    // trip the wrong check and revert with a misleading error.
    const { params } = decodeV4(inputs[0]!);
    const [swap] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            {
              name: 'poolKey', type: 'tuple',
              components: [
                { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
                { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
              ],
            },
            { name: 'zeroForOne', type: 'bool' },
            { name: 'amountIn', type: 'uint128' },
            { name: 'amountOutMinimum', type: 'uint128' },
            { name: 'hookData', type: 'bytes' },
          ],
        },
      ],
      params[0]!,
    ) as unknown as [{ amountOutMinimum: bigint; amountIn: bigint }];
    expect(swap.amountOutMinimum).toBe(0n);
    expect(swap.amountIn).toBe(500n);
  });
});

describe('approvalNeeded (V4 = two steps via Permit2)', () => {
  const owner = getAddress('0x0000000000000000000000000000000000000003');

  it('step 1: approves the token to Permit2, not to the router', async () => {
    const a = writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked), 1000n, {
      [`${TOKEN.toLowerCase()}.allowance`]: 0n,
    });
    const tx = await a.approvalNeeded(token, owner, 500n);
    expect(tx!.to).toBe(TOKEN);
    const [spender] = decodeFunctionData({ abi: ERC20_ABI_MIN, data: tx!.data }).args as readonly [Address, bigint];
    expect(spender).toBe(PERMIT2);
  });

  it('step 2: grants the router an allowance inside Permit2', async () => {
    const a = writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked), 1000n, {
      [`${TOKEN.toLowerCase()}.allowance`]: 10n ** 30n,
      [`${PERMIT2.toLowerCase()}.allowance`]: [0n, 0, 0],
    });
    const tx = await a.approvalNeeded(token, owner, 500n);
    expect(tx!.to).toBe(PERMIT2);
    const d = decodeFunctionData({ abi: PERMIT2_ABI, data: tx!.data });
    const [tok, spender, amount] = d.args as readonly [Address, Address, bigint, number];
    expect(tok).toBe(TOKEN);
    expect(spender).toBe(UNIVERSAL_ROUTER);
    expect(amount).toBe(500n);
  });

  it('returns null only when BOTH grants are in place and unexpired', async () => {
    const future = Math.floor(NOW() / 1000) + 3600;
    const a = writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked), 1000n, {
      [`${TOKEN.toLowerCase()}.allowance`]: 10n ** 30n,
      [`${PERMIT2.toLowerCase()}.allowance`]: [10n ** 30n, future, 0],
    });
    expect(await a.approvalNeeded(token, owner, 500n)).toBeNull();
  });

  it('re-approves when the Permit2 allowance is large but EXPIRED', async () => {
    // An expired allowance is worth nothing however big it is — treating
    // amount alone as sufficient would produce a sell that always reverts.
    const past = Math.floor(NOW() / 1000) - 1;
    const a = writeAdapter(stateTuple(DOPPLER_POOL_STATUS.Locked), 1000n, {
      [`${TOKEN.toLowerCase()}.allowance`]: 10n ** 30n,
      [`${PERMIT2.toLowerCase()}.allowance`]: [10n ** 30n, past, 0],
    });
    const tx = await a.approvalNeeded(token, owner, 500n);
    expect(tx).not.toBeNull();
    expect(tx!.to).toBe(PERMIT2);
  });
});

const ERC20_ABI_MIN = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;
