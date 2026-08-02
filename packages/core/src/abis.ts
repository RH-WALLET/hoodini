/**
 * Minimal ABIs — only the functions Hoodini actually calls.
 *
 * Deliberately hand-written rather than pulled wholesale from the explorer: a
 * narrow ABI means a typo in a function name is a compile error, and it makes
 * the entire set of things this extension can call auditable on one screen.
 *
 * Every address these are used against is VERIFIED in DATA_SOURCES.md (D-010).
 */

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

/** Pons-family launch token. `launchFactory()` is the cheap attribution read (D-008). */
export const PONS_TOKEN_ABI = [
  { type: 'function', name: 'launchFactory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'liquidityPool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'pairToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'poolFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const;

/**
 * Pons launch factory. `graduationStatus` returns (raised, threshold, graduated)
 * — one static call, and the whole of `state()` (D-016).
 */
export const PONS_FACTORY_ABI = [
  {
    type: 'function',
    name: 'graduationStatus',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'raised', type: 'uint256' }, { name: 'threshold', type: 'uint256' }, { name: 'graduated', type: 'bool' }],
  },
] as const;

export const UNISWAP_V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }, { name: 'b', type: 'address' }, { name: 'fee', type: 'uint24' }],
    outputs: [{ type: 'address' }],
  },
] as const;

export const UNISWAP_V3_POOL_ABI = [
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
] as const;

/**
 * QuoterV2. `quoteExactInputSingle` is state-mutating in the ABI but is only
 * ever reached via eth_call — it reverts internally to return its result, so it
 * can never be broadcast by us.
 */
export const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

/**
 * SwapRouter02 — the swap surface, and ONLY the fee-free entry points.
 *
 * The deployed router also exposes `sweepTokenWithFee`, `unwrapWETH9WithFee`
 * and `swapExactTokensForTokens`. The *WithFee variants take feeBips and a
 * feeRecipient, which is precisely the mechanism CLAUDE.md invariant 6 forbids.
 * They are omitted here so no code path can reach them even by accident — with
 * a narrow ABI, calling one is a type error rather than a silent skim.
 *
 * `exactInputSingle` carries no deadline; Pons's own dex config advertises this
 * with `routerRequiresDeadline: false`. Deadlines go on `multicall(uint256,bytes[])`.
 */
export const SWAP_ROUTER_02_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  { type: 'function', name: 'multicall', stateMutability: 'payable', inputs: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], outputs: [{ type: 'bytes[]' }] },
  { type: 'function', name: 'refundETH', stateMutability: 'payable', inputs: [], outputs: [] },
  // The single-argument overload, which forwards to msg.sender. The two-arg form
  // takes a literal address and does NOT resolve the MSG_SENDER sentinel, so it
  // is deliberately not declared here.
  { type: 'function', name: 'unwrapWETH9', stateMutability: 'payable', inputs: [{ name: 'amountMinimum', type: 'uint256' }], outputs: [] },
] as const;

/**
 * Router sentinels, read from the deployed verified source:
 *
 *   if (recipient == Constants.MSG_SENDER)   recipient = msg.sender;
 *   else if (recipient == Constants.ADDRESS_THIS) recipient = address(this);
 *
 * Using MSG_SENDER means built calldata is bound to whoever signs it rather
 * than to an address baked in at build time — so `buildBuy`/`buildSell` need no
 * owner parameter, and calldata built for one account can never pay out to
 * another.
 */
export const MSG_SENDER = '0x0000000000000000000000000000000000000001' as const;
export const ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as const;

/**
 * The router treats `amountIn == 0` as CONTRACT_BALANCE — "swap this contract's
 * entire balance of tokenIn". A zero amount must therefore never reach the
 * router; adapters reject it before encoding.
 */
export const CONTRACT_BALANCE_FLAG = 0n;
