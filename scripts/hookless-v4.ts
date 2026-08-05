/**
 * scripts/hookless-v4.ts — who is creating the hookless V4 pools?
 *
 * `v4-hooks.ts` shows that ~88% of recent V4 pool initialisations on this chain
 * carry no hook at all. Every V4 adapter here is keyed to a hook, so that whole
 * class is currently untradeable — and "no hook" is not a venue, it is the
 * absence of one, so the question is which deployer is behind them.
 *
 * Method is the census method (D-007): take the token side of each pool, ask
 * Blockscout who created it, and tally. A launchpad shows up as one creator
 * repeated hundreds of times; organic pool creation shows up as a long tail.
 *
 * READ-ONLY.
 *
 *   pnpm tsx scripts/hookless-v4.ts [blocks]
 */

import { createPublicClient, defineChain, http, parseAbiItem, zeroAddress, type Address } from 'viem';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/api/v2';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const;
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'.toLowerCase();

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

const span = BigInt(process.argv[2] ?? 60_000);
const head = await client.getBlockNumber();

const logs = await client.getLogs({
  address: POOL_MANAGER,
  event: INITIALIZE,
  fromBlock: head - span,
  toBlock: head,
});

const hookless = logs.filter((l) => (l.args.hooks as string)?.toLowerCase() === zeroAddress);
console.log(`${logs.length} initialisations in ${span} blocks; ${hookless.length} hookless\n`);

/** Fee/spacing pairs, because a launchpad uses one and organic pools do not. */
const shapes = new Map<string, number>();
for (const l of hookless) {
  const k = `fee=${l.args.fee} spacing=${l.args.tickSpacing}`;
  shapes.set(k, (shapes.get(k) ?? 0) + 1);
}
console.log('hookless pool shapes:');
for (const [shape, n] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(n).padStart(5)}  ${shape}`);
}

/** The side that is not ETH/WETH is the launched token. */
function tokenOf(log: (typeof hookless)[number]): Address | null {
  for (const side of [log.args.currency0, log.args.currency1] as (Address | undefined)[]) {
    if (!side) continue;
    const s = side.toLowerCase();
    if (s === zeroAddress || s === WETH) continue;
    return side;
  }
  return null;
}

const creators = new Map<string, { count: number; sample: Address; name?: string }>();
const tokens = [...new Set(hookless.map(tokenOf).filter((t): t is Address => t !== null))];
const sample = tokens.slice(0, 60);

console.log(`\nasking Blockscout who created ${sample.length} of ${tokens.length} tokens…`);
for (const token of sample) {
  try {
    const res = await fetch(`${BLOCKSCOUT}/addresses/${token}`);
    if (!res.ok) continue;
    const json = (await res.json()) as { creator_address_hash?: string };
    const creator = json.creator_address_hash;
    if (!creator) continue;
    const key = creator.toLowerCase();
    const seen = creators.get(key);
    if (seen) seen.count++;
    else creators.set(key, { count: 1, sample: token });
  } catch {
    // A single lookup failing tells us nothing; the tally is what matters.
  }
}

console.log('\ncreators, by how many of the sampled tokens they deployed:');
for (const [creator, info] of [...creators.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10)) {
  let label = '';
  try {
    const res = await fetch(`${BLOCKSCOUT}/addresses/${creator}`);
    if (res.ok) {
      const j = (await res.json()) as { name?: string; is_contract?: boolean };
      label = `${j.name ?? ''}${j.is_contract ? ' (contract)' : ' (EOA)'}`;
    }
  } catch {
    /* label is a nicety */
  }
  console.log(`  ${String(info.count).padStart(3)}  ${creator}  ${label}`);
  console.log(`       e.g. token ${info.sample}`);
}

console.log(
  '\nA launchpad appears as one creator repeated many times. A long tail of one-offs means these are organic pools and there is no venue to adapt.',
);
