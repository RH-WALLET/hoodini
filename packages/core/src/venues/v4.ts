/**
 * Shared Uniswap V4 swap encoding.
 *
 * Doppler and klik both settle on V4 through the same PoolManager, quoter and
 * UniversalRouter, so the encoding lives here once and each adapter supplies
 * only its PoolKey. That is what makes a new V4 venue a thin adapter rather
 * than a second copy of this logic.
 *
 * The one real difference between them is the numeraire:
 *
 * - **WETH-paired** (Doppler): the router must `WRAP_ETH` first and then settle
 *   from its own balance, because the pool trades the ERC-20 and the user holds
 *   native ETH.
 * - **Native-paired** (klik): V4 handles `address(0)` directly, so the swap
 *   settles straight from `msg.value` and no wrapping happens at all.
 *
 * Getting that wrong is not a subtle bug — a wrapped path against a native pool
 * settles the wrong currency and reverts.
 */

import { encodeAbiParameters, encodeFunctionData, isAddressEqual, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem';
import { ADDRESS_THIS, MSG_SENDER, UNIVERSAL_ROUTER_ABI, UR_COMMANDS, V4_ACTIONS, V4_OPEN_DELTA } from '../abis.js';
import { UNIVERSAL_ROUTER, WETH } from './registry.js';
import type { PoolKey } from './doppler.js';

/** Commands and actions are one byte each, concatenated. */
export function packBytes(values: readonly number[]): Hex {
  return `0x${values.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** V4_SWAP's input is abi.encode(bytes actions, bytes[] params). */
export function encodeV4Actions(actions: readonly number[], params: readonly Hex[]): Hex {
  return encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [packBytes(actions), [...params]]);
}

/** IV4Router.ExactInputSingleParams, field order from the deployed source. */
export function encodeExactInSingle(
  poolKey: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMinimum: bigint,
): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData: '0x' }],
  );
}

export interface V4SwapArgs {
  readonly poolKey: PoolKey;
  readonly numeraire: Address;
  readonly token: Address;
  readonly amountIn: bigint;
  readonly minOut: bigint;
  readonly deadline: bigint;
}

/** Encoded `execute(commands, inputs, deadline)` calldata plus its value. */
export interface V4Call {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

const isNative = (a: Address) => isAddressEqual(a, zeroAddress);

/**
 * Buy: ETH in, token out.
 *
 * Native-paired pools settle straight from `msg.value`; WETH-paired pools wrap
 * first and settle from the router's own balance, which is what keeps a buy
 * free of any Permit2 approval.
 */
export function encodeV4Buy(args: V4SwapArgs): V4Call {
  const { poolKey, numeraire, token, amountIn, minOut, deadline } = args;
  const zeroForOne = isAddressEqual(poolKey.currency0, numeraire);
  const swap = encodeExactInSingle(poolKey, zeroForOne, amountIn, minOut);
  const takeAll = encodeAbiParameters(parseAbiParameters('address, uint256'), [token, minOut]);

  if (isNative(numeraire)) {
    // payerIsUser = true: the user's msg.value is the input, so no wrap and no
    // router balance is involved.
    const settle = encodeAbiParameters(parseAbiParameters('address, uint256, bool'), [numeraire, amountIn, true]);
    return {
      to: UNIVERSAL_ROUTER,
      data: encodeFunctionData({
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: 'execute',
        args: [
          packBytes([UR_COMMANDS.V4_SWAP]),
          [encodeV4Actions([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE, V4_ACTIONS.TAKE_ALL], [swap, settle, takeAll])],
          deadline,
        ],
      }),
      value: amountIn,
    };
  }

  // WETH-paired: wrap into the router, then settle from its balance.
  const settle = encodeAbiParameters(parseAbiParameters('address, uint256, bool'), [numeraire, amountIn, false]);
  return {
    to: UNIVERSAL_ROUTER,
    data: encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [
        packBytes([UR_COMMANDS.WRAP_ETH, UR_COMMANDS.V4_SWAP]),
        [
          encodeAbiParameters(parseAbiParameters('address, uint256'), [ADDRESS_THIS, amountIn]),
          encodeV4Actions([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE, V4_ACTIONS.TAKE_ALL], [swap, settle, takeAll]),
        ],
        deadline,
      ],
    }),
    value: amountIn,
  };
}

/**
 * Sell: token in, ETH out.
 *
 * `SETTLE_ALL` pulls the token from the user via Permit2 in both cases. The
 * difference is the payout: a native pool can pay the signer directly, while a
 * WETH pool must route the proceeds to the router so `UNWRAP_WETH` can convert
 * them — which is also where slippage is enforced, since that is where the ETH
 * the user actually receives is measured.
 */
export function encodeV4Sell(args: V4SwapArgs): V4Call {
  const { poolKey, numeraire, token, amountIn, minOut, deadline } = args;
  const zeroForOne = isAddressEqual(poolKey.currency0, token);
  const settleAll = encodeAbiParameters(parseAbiParameters('address, uint256'), [token, amountIn]);

  if (isNative(numeraire)) {
    const swap = encodeExactInSingle(poolKey, zeroForOne, amountIn, minOut);
    const takeAll = encodeAbiParameters(parseAbiParameters('address, uint256'), [numeraire, minOut]);
    return {
      to: UNIVERSAL_ROUTER,
      data: encodeFunctionData({
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: 'execute',
        args: [
          packBytes([UR_COMMANDS.V4_SWAP]),
          [encodeV4Actions([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL], [swap, settleAll, takeAll])],
          deadline,
        ],
      }),
      value: 0n,
    };
  }

  // WETH-paired: keep the proceeds in the router, unwrap to the signer.
  const swap = encodeExactInSingle(poolKey, zeroForOne, amountIn, 0n);
  const take = encodeAbiParameters(parseAbiParameters('address, address, uint256'), [WETH, ADDRESS_THIS, V4_OPEN_DELTA]);
  return {
    to: UNIVERSAL_ROUTER,
    data: encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [
        packBytes([UR_COMMANDS.V4_SWAP, UR_COMMANDS.UNWRAP_WETH]),
        [
          encodeV4Actions([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE], [swap, settleAll, take]),
          encodeAbiParameters(parseAbiParameters('address, uint256'), [MSG_SENDER, minOut]),
        ],
        deadline,
      ],
    }),
    value: 0n,
  };
}
