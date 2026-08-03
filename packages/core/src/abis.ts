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

// ── Doppler (Uniswap V4) ────────────────────────────────────────────────────

/**
 * Doppler's hook. On V4 the launchpad *is* the hook — there is no factory to
 * ask and no curve contract to call, so the hook is both the attribution
 * source and the state oracle.
 *
 * `getState(asset)` returns the asset's numeraire and its full PoolKey, which is
 * everything needed to price a swap.
 */
export const DOPPLER_HOOK_ABI = [
  {
    type: 'function',
    name: 'getState',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'numeraire', type: 'address' },
      { name: 'reserves', type: 'uint256' },
      { name: 'beneficiary', type: 'address' },
      { name: 'extra', type: 'bytes' },
      { name: 'status', type: 'uint8' },
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
    ],
  },
  { type: 'function', name: 'airlock', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'poolManager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/**
 * `enum PoolStatus { Uninitialized, Initialized, Locked, Graduated, Exited }`
 * — read from the hook's verified source, not inferred from observed values.
 */
export const DOPPLER_POOL_STATUS = {
  Uninitialized: 0,
  Initialized: 1,
  Locked: 2,
  Graduated: 3,
  Exited: 4,
} as const;

/** V4 quoting. eth_call only — it reverts internally to return its result. */
export const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
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
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

/**
 * Uniswap V4's dynamic-fee flag (`LPFeeLibrary.DYNAMIC_FEE_FLAG`). Every Doppler
 * pool observed carries it, so the pool's fee is set by the hook per swap and
 * `PoolKey.fee` is a marker rather than a rate. A Quote's feeBps cannot be read
 * off the key for such pools.
 */
export const V4_DYNAMIC_FEE_FLAG = 0x800000;

// ── Uniswap V4 write path (UniversalRouter + Permit2) ───────────────────────

/**
 * UniversalRouter. Every constant below was read out of the deployed verified
 * source at 0x53BF6B06…, not assumed from upstream Uniswap.
 *
 * Note the chain has a second UniversalRouter (0x8876…) that is a FORK: its
 * COMMAND_TYPE_MASK is 0x7f rather than 0x3f and it adds `executeSigned`. The
 * canonical one is pinned so command encoding stays predictable.
 */
export const UNIVERSAL_ROUTER_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** `library Commands` — verified source. */
export const UR_COMMANDS = {
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  V4_SWAP: 0x10,
} as const;

/** `library Actions` — verified source. */
export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
} as const;

/**
 * `library ActionConstants` — verified source.
 * OPEN_DELTA (0) means "use whatever the pool manager currently owes", which is
 * how a swap's output is handed to the next action without knowing the amount.
 */
export const V4_OPEN_DELTA = 0n;

/** Canonical Permit2, confirmed as constructor arg [0] of the pinned router. */
export const PERMIT2_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

// ── flap.sh Portal ──────────────────────────────────────────────────────────

/**
 * flap.sh Portal — the live trade surface only.
 *
 * `buy(address,address,uint256)` and `sell(address,uint256,uint256)` are
 * deliberately NOT declared here. They still appear in the deployed ABI, but
 * both bodies are `revert FeatureDisabled()` in the verified source. Omitting
 * them makes calling a dead entry point a type error rather than a runtime
 * revert discovered by a user (D-032).
 *
 * `address(0)` means the native asset on either side of a swap. There is no
 * recipient parameter — output goes to `msg.sender` — so built calldata is
 * bound to whoever signs it.
 */
export const FLAP_PORTAL_ABI = [
  {
    type: 'function',
    name: 'swapExactInput',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'inputToken', type: 'address' },
          { name: 'outputToken', type: 'address' },
          { name: 'inputAmount', type: 'uint256' },
          { name: 'minOutputAmount', type: 'uint256' },
          { name: 'permitData', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'outputAmount', type: 'uint256' }],
  },
  {
    // Non-payable but only ever reached via eth_call.
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { name: 'inputToken', type: 'address' },
          { name: 'outputToken', type: 'address' },
          { name: 'inputAmount', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'outputAmount', type: 'uint256' }],
  },
  {
    // Reverts for any token the Portal did not launch, which is the membership test.
    type: 'function',
    name: 'getTokenV9Safe',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'status', type: 'uint8' },
          { name: 'reserve', type: 'uint256' },
          { name: 'circulatingSupply', type: 'uint256' },
          { name: 'price', type: 'uint256' },
          { name: 'tokenVersion', type: 'uint8' },
          { name: 'r', type: 'uint256' },
          { name: 'h', type: 'uint256' },
          { name: 'k', type: 'uint256' },
          { name: 'dexSupplyThresh', type: 'uint256' },
          { name: 'quoteTokenAddress', type: 'address' },
          { name: 'nativeToQuoteSwapEnabled', type: 'bool' },
          { name: 'extensionID', type: 'bytes32' },
          { name: 'buyTaxRate', type: 'uint256' },
          { name: 'sellTaxRate', type: 'uint256' },
          { name: 'pool', type: 'address' },
          { name: 'progress', type: 'uint256' },
          { name: 'lpFeeProfile', type: 'uint8' },
          { name: 'dexId', type: 'uint8' },
          { name: 'bondingCurveFeeRate', type: 'uint16' },
        ],
      },
    ],
  },
] as const;

// ── klik.finance ────────────────────────────────────────────────────────────

/**
 * klik factory — the two reads the adapter needs.
 *
 * `tokenInfoByAddress` returns an all-zero struct for a token klik did not
 * launch (verified against a Pons token), so a non-zero `token` field is the
 * membership test. `getTokenPrice` returns the pool id first, which is what
 * lets a constructed PoolKey be checked against the chain instead of trusted.
 */
export const KLIK_FACTORY_ABI = [
  {
    type: 'function',
    name: 'tokenInfoByAddress',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'creator', type: 'address' },
      { name: 'createdAt', type: 'uint256' },
      { name: 'metadataURI', type: 'string' },
      { name: 'configId', type: 'uint256' },
      { name: 'index', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getTokenPrice',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'sqrtPriceX96', type: 'uint256' },
      { name: 'price', type: 'uint256' },
      { name: 'priceScaled', type: 'uint256' },
    ],
  },
] as const;
