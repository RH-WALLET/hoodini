/**
 * scripts/doppler-states.ts — do Graduated or Exited Doppler pools exist?
 *
 * P1b-2 left one item open: `state()` maps Doppler's `PoolStatus` enum, but no
 * Graduated or Exited token was ever observed, so two of the five branches have
 * never been seen against the chain. An enum branch nobody has witnessed is a
 * guess with a type annotation.
 *
 * Method: enumerate V4 `Initialize` events, keep the pools whose hook is
 * Doppler's, and ask the hook for each token's status. Reports the distribution.
 *
 * READ-ONLY. No signer, no writes.
 *
 *   pnpm tsx scripts/doppler-states.ts [blocks] [endBlock]
 *
 * `endBlock` defaults to the head. Pass an early one to look where graduates
 * would actually be: a token launched an hour ago has had no chance to
 * graduate, so a recent-only scan finding none proves very little.
 */

import { createPublicClient, defineChain, http, parseAbiItem, zeroAddress, type Address } from 'viem';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const;
const DOPPLER_HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544' as const;

/** Names from the adapter's own comment, so the two cannot drift apart. */
const STATUS_NAMES = ['Uninitialized', 'Initialized', 'Locked', 'Graduated', 'Exited'] as const;

const chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain, transport: http(RPC) });

const INITIALIZE = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

const GET_STATE = [
  {
    type: 'function',
    name: 'getState',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    // Copied field-for-field from DOPPLER_HOOK_ABI in packages/core/src/abis.ts.
    // A first pass here declared three outputs instead of six, which read
    // `reserves` as the status, failed to decode for most assets, and reported
    // a confident "none found" from twenty garbage answers. A recon script that
    // can produce a false negative is worse than none.
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
] as const;

const span = BigInt(process.argv[2] ?? 400_000);
const tip = await client.getBlockNumber();
const head = process.argv[3] ? BigInt(process.argv[3]) : tip;

console.log(`Doppler hook  ${DOPPLER_HOOK}`);
console.log(`scanning      ${span} blocks ending at ${head}${head === tip ? ' (chain head)' : ` (head is ${tip})`}\n`);

/**
 * getLogs over a long span can exceed a node's limit, so walk it in windows and
 * report how much was actually covered — a partial scan reported as a full one
 * would turn "not found" into a false negative, which is the failure mode this
 * script exists to avoid.
 */
const WINDOW = 50_000n;
const pools: { asset: Address; block: bigint }[] = [];
let scanned = 0n;

for (let to = head; to > head - span; to -= WINDOW) {
  const from = to - WINDOW + 1n > head - span ? to - WINDOW + 1n : head - span;
  try {
    const logs = await client.getLogs({ address: POOL_MANAGER, event: INITIALIZE, fromBlock: from, toBlock: to });
    scanned += to - from + 1n;
    for (const log of logs) {
      const hooks = log.args.hooks as Address | undefined;
      if (!hooks || hooks.toLowerCase() !== DOPPLER_HOOK.toLowerCase()) continue;
      // The asset is whichever side is not the numeraire; try both.
      for (const side of [log.args.currency0, log.args.currency1]) {
        if (side && side !== zeroAddress) pools.push({ asset: side as Address, block: log.blockNumber });
      }
    }
  } catch (e) {
    console.log(`  window ${from}-${to} failed: ${(e as Error).message.split('\n')[0]}`);
  }
}

console.log(`covered ${scanned} of ${span} blocks; ${pools.length} Doppler-hook pool sides found\n`);

if (pools.length === 0) {
  console.log('No Doppler pools in range. Widen the span, or the venue is quiet.');
  process.exit(0);
}

const counts = new Map<number, number>();
const examples = new Map<number, Address>();
let queried = 0;

const unique = [...new Map(pools.map((p) => [p.asset.toLowerCase(), p])).values()];
for (const { asset } of unique) {
  try {
    const res = (await client.readContract({
      address: DOPPLER_HOOK,
      abi: GET_STATE,
      functionName: 'getState',
      args: [asset],
    })) as readonly unknown[];
    const status = Number(res[4]);
    queried++;
    counts.set(status, (counts.get(status) ?? 0) + 1);
    if (!examples.has(status)) examples.set(status, asset);
  } catch {
    // Not a Doppler asset, or the hook reverts for this side. Expected: each
    // pool contributes two candidate sides and only one is the asset.
  }
}

console.log(`queried ${queried} of ${unique.length} candidate assets\n`);
console.log('status distribution:');
for (const [status, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
  const name = STATUS_NAMES[status] ?? `unknown(${status})`;
  console.log(`  ${String(name).padEnd(14)} ${String(n).padStart(4)}   e.g. ${examples.get(status)}`);
}

const graduated = [3, 4].filter((s) => counts.has(s));
console.log(
  graduated.length
    ? `\nFOUND: ${graduated.map((s) => STATUS_NAMES[s]).join(', ')} — P1b-2's open item can close.`
    : '\nNone Graduated or Exited in this range. Those two branches remain unwitnessed.',
);
