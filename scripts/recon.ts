/**
 * scripts/recon.ts — Robinhood Chain launchpad census.
 *
 * READ-ONLY BY CONSTRUCTION. This script has no signer, imports nothing that can
 * sign, and issues only eth_chainId / eth_blockNumber / eth_gasPrice /
 * eth_getBlockByNumber / eth_call plus public explorer GETs. There is no send
 * path in this repo at all (P0), and LIVE_TRADING stays false.
 *
 *   pnpm recon
 *
 * Output: a printed census plus scripts/out/census.json (gitignored). The
 * durable record is DATA_SOURCES.md, which this script's findings populate.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  defineChain,
  http,
  formatEther,
  formatGwei,
  getAddress,
  decodeFunctionResult,
  encodeFunctionData,
  isAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── config ───────────────────────────────────────────────────────────────────

const RPC_URL = process.env['RPC_URL'] ?? 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = Number(process.env['CHAIN_ID'] ?? 4663);
const EXPLORER_API = process.env['EXPLORER_API'] ?? 'https://robinhoodchain.blockscout.com/api';

const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC_URL) });

// ── seeds ────────────────────────────────────────────────────────────────────

interface Seeds {
  readonly knownFactoryCandidates: { name: string; address: string; source: string }[];
  readonly knownInfra: { name: string; address: string; source: string }[];
  readonly tokens: { address: string; symbol?: string; labelledLaunchpad?: string | null; source: string }[];
}

const seeds = JSON.parse(readFileSync(resolve(HERE, 'seeds.json'), 'utf8')) as Seeds;

// ── tiny helpers ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a Blockscout endpoint with retry/backoff. Returns null on give-up. */
async function api<T>(path: string, attempts = 3): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${EXPLORER_API}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        await sleep(400 * (i + 1));
        continue;
      }
      return (await res.json()) as T;
    } catch {
      await sleep(400 * (i + 1));
    }
  }
  return null;
}

/** Single static call, decoded. Returns null when the call reverts. */
async function callOne<T>(to: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T | null> {
  try {
    const data = encodeFunctionData({ abi, functionName, args });
    const { data: out } = await client.call({ to, data });
    if (!out || out === '0x') return null;
    return decodeFunctionResult({ abi, functionName, data: out }) as T;
  } catch {
    return null;
  }
}

const fn = (sig: string, outputs: string[] = [], inputs: string[] = []): Abi => {
  const name = sig.slice(0, sig.indexOf('('));
  return [
    {
      type: 'function',
      name,
      stateMutability: 'view',
      inputs: inputs.map((t, i) => ({ name: `a${i}`, type: t })),
      outputs: outputs.map((t, i) => ({ name: `o${i}`, type: t })),
    },
  ] as Abi;
};

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;
const h1 = (s: string) => console.log(`\n${'━'.repeat(78)}\n${s}\n${'━'.repeat(78)}`);
const h2 = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`);

/** Fixed-width table printer. */
function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => '  ' + cells.map((c, i) => (c ?? '').padEnd(w[i] ?? 0)).join('  ');
  console.log(line(headers));
  console.log('  ' + w.map((n) => '─'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
}

// ── explorer types (only the fields we use) ──────────────────────────────────

interface AddrInfo {
  hash: string;
  is_contract: boolean;
  is_verified: boolean;
  name: string | null;
  creator_address_hash: string | null;
  creation_transaction_hash: string | null;
  proxy_type: string | null;
  implementations: { address?: string; address_hash?: string; name?: string | null }[];
  token?: { symbol?: string; name?: string } | null;
}

interface ContractInfo {
  name: string | null;
  is_verified?: boolean;
  compiler_version?: string;
  abi?: Abi | null;
  proxy_type?: string | null;
}

interface TxInfo {
  hash: string;
  method: string | null;
  to: { hash: string; name: string | null; is_verified?: boolean } | null;
  value?: string;
}

// ── report accumulator ───────────────────────────────────────────────────────

interface LaunchpadRecord {
  name: string;
  factory: string;
  verified: boolean;
  compiler?: string;
  proxy: string | null;
  tokensAttributed: number;
  evidence: string[];
  launchOpen?: boolean | null;
  launchFeeWei?: string | null;
  membershipCheck?: string;
  membershipEvidence?: string;
  tradeModel?: string;
  buySellPath?: string;
  quoteMethod?: string;
  graduationSignal?: string;
  destinationDex?: string;
  sampleToken?: string;
  samplePool?: string;
  status: 'VERIFIED' | 'UNCONFIRMED';
}

const report = {
  ranAt: new Date().toISOString(),
  chain: {} as Record<string, unknown>,
  launchpads: [] as LaunchpadRecord[],
  routers: [] as Record<string, unknown>[],
  quotes: [] as Record<string, unknown>[],
  unresolved: [] as Record<string, unknown>[],
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Chain sanity
// ─────────────────────────────────────────────────────────────────────────────

async function chainSanity(): Promise<void> {
  h1('1 · CHAIN SANITY');

  const [id, block, gas] = await Promise.all([client.getChainId(), client.getBlock(), client.getGasPrice()]);

  const ok = id === CHAIN_ID;
  console.log(`  RPC                ${RPC_URL}`);
  console.log(`  chainId            ${id} ${ok ? '✓ matches configured ' + CHAIN_ID : '✗ EXPECTED ' + CHAIN_ID}`);
  if (!ok) throw new Error(`chainId mismatch: RPC says ${id}, config says ${CHAIN_ID}. Refusing to continue.`);

  console.log(`  latest block       ${block.number} (${new Date(Number(block.timestamp) * 1000).toISOString()})`);
  console.log(`  gas price          ${formatGwei(gas)} gwei (${gas} wei)`);

  // Block time from a 1,000-block span — Orbit chains produce blocks on demand,
  // so a short sample is misleading.
  const back = 1000n;
  const past = await client.getBlock({ blockNumber: block.number - back });
  const span = Number(block.timestamp - past.timestamp);
  const blockTime = span / Number(back);
  console.log(`  block time         ${blockTime.toFixed(3)} s/block (mean over ${back} blocks)`);
  console.log(`  explorer           ${EXPLORER_API}`);

  report.chain = {
    rpc: RPC_URL,
    chainId: id,
    latestBlock: block.number.toString(),
    latestBlockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    gasPriceWei: gas.toString(),
    gasPriceGwei: formatGwei(gas),
    meanBlockTimeSec: Number(blockTime.toFixed(3)),
    explorer: EXPLORER_API,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Launchpad census — attribute seed tokens to their creating factory
// ─────────────────────────────────────────────────────────────────────────────

interface Attribution {
  token: string;
  symbol: string;
  creator: string | null;
  creationTx: string | null;
  labelled: string | null;
}

async function censusByCreationTrace(): Promise<{ attributions: Attribution[]; factories: Map<string, Attribution[]> }> {
  h1('2 · LAUNCHPAD CENSUS — creation-tx trace');
  console.log(`  Tracing ${seeds.tokens.length} seed token CAs back to their deploying contract.`);
  console.log('  Method: Blockscout creator_address_hash (the factory that ran CREATE/CREATE2).\n');

  const attributions: Attribution[] = [];
  const CONCURRENCY = 6;

  for (let i = 0; i < seeds.tokens.length; i += CONCURRENCY) {
    const batch = seeds.tokens.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (t) => {
        const info = await api<AddrInfo>(`/v2/addresses/${t.address}`);
        return {
          token: t.address,
          symbol: t.symbol ?? info?.token?.symbol ?? '?',
          creator: info?.creator_address_hash ? getAddress(info.creator_address_hash) : null,
          creationTx: info?.creation_transaction_hash ?? null,
          labelled: t.labelledLaunchpad ?? null,
        } satisfies Attribution;
      }),
    );
    attributions.push(...results);
    process.stdout.write(`\r  traced ${Math.min(i + CONCURRENCY, seeds.tokens.length)}/${seeds.tokens.length}`);
    await sleep(120);
  }
  process.stdout.write('\n\n');

  const factories = new Map<string, Attribution[]>();
  for (const a of attributions) {
    if (!a.creator) continue;
    const list = factories.get(a.creator) ?? [];
    list.push(a);
    factories.set(a.creator, list);
  }

  const rows: string[][] = [];
  for (const [factory, toks] of [...factories.entries()].sort((x, y) => y[1].length - x[1].length)) {
    const info = await api<AddrInfo>(`/v2/addresses/${factory}`);
    const labels = [...new Set(toks.map((t) => t.labelled).filter(Boolean))].join(',') || '—';
    rows.push([
      info?.name ?? '(unnamed)',
      factory,
      String(toks.length),
      info?.is_verified ? 'verified' : 'UNVERIFIED',
      labels,
    ]);
  }
  table(['explorer name', 'factory address', 'tokens', 'source', 'seed label'], rows);

  const orphans = attributions.filter((a) => !a.creator);
  if (orphans.length > 0) {
    console.log(`\n  ⚠ ${orphans.length} seed(s) had no creator on the explorer (EOA-deployed or not indexed):`);
    for (const o of orphans) console.log(`     ${o.token} ${o.symbol}`);
    report.unresolved.push({ kind: 'no-creator', tokens: orphans.map((o) => o.token) });
  }

  return { attributions, factories };
}

/** Cross-check: are the launchpads named in the harvest notes still live? */
async function censusByKnownCandidates(seen: Set<string>): Promise<Map<string, string>> {
  h2('Harvested launchpad candidates (re-checked on-chain)');
  const names = new Map<string, string>();
  const rows: string[][] = [];

  for (const cand of seeds.knownFactoryCandidates) {
    const addr = getAddress(cand.address);
    names.set(addr, cand.name);
    const info = await api<AddrInfo>(`/v2/addresses/${addr}`);
    const code = await client.getCode({ address: addr });
    const hasCode = !!code && code !== '0x';

    // Launch-gate reads. Each launchpad names it differently; all are optional.
    const launchEnabled = await callOne<boolean>(addr, fn('launchEnabled()', ['bool']), 'launchEnabled');
    const deployEnabled = await callOne<boolean>(addr, fn('deployCoinEnabled()', ['bool']), 'deployCoinEnabled');
    const feeWei = await callOne<bigint>(addr, fn('launchFee()', ['uint256']), 'launchFee');

    const gate =
      launchEnabled !== null ? `launchEnabled=${launchEnabled}` : deployEnabled !== null ? `deployCoinEnabled=${deployEnabled}` : '—';

    rows.push([
      cand.name,
      addr,
      hasCode ? 'yes' : 'NO CODE',
      info?.is_verified ? 'verified' : 'unverified',
      gate,
      feeWei !== null ? `${formatEther(feeWei)} ETH` : '—',
      seen.has(addr) ? 'yes' : 'no',
    ]);
  }
  table(['harvest name', 'address', 'code', 'source', 'launch gate', 'launch fee', 'in seed trace'], rows);
  console.log('\n  "in seed trace" = whether this factory actually deployed any of the 74 seed tokens.');
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Per-launchpad detail
// ─────────────────────────────────────────────────────────────────────────────

/** Classify an ABI's trade surface. */
function classifyAbi(abi: Abi): {
  buySell: string[];
  quoteViews: string[];
  graduation: string[];
  membership: string[];
} {
  const fns = abi.filter((e): e is Extract<Abi[number], { type: 'function' }> => e.type === 'function');
  const evs = abi.filter((e): e is Extract<Abi[number], { type: 'event' }> => e.type === 'event');
  const sigOf = (f: { name: string; inputs?: readonly { type: string }[]; stateMutability?: string }) =>
    `${f.name}(${(f.inputs ?? []).map((i) => i.type).join(',')})${f.stateMutability === 'payable' ? ' payable' : ''}`;

  return {
    buySell: fns.filter((f) => /^(buy|sell|swap|exactInput|exactOutput|trade|mint|burn)/i.test(f.name)).map(sigOf),
    quoteViews: fns
      .filter((f) => f.stateMutability === 'view' && /(quote|price|amountOut|amountIn|reserve|getAmount|slot0)/i.test(f.name))
      .map(sigOf),
    graduation: [
      ...fns.filter((f) => /(graduat|migrat|complete|listing|bond)/i.test(f.name)).map(sigOf),
      ...evs.filter((e) => /(graduat|migrat|complete|listing|bond)/i.test(e.name)).map((e) => `event ${e.name}`),
    ],
    membership: fns
      .filter((f) => f.stateMutability === 'view' && /(getLaunchedToken|isToken|tokens|launchFactory|getTokenInfo|pool|curve|info)/i.test(f.name))
      .map(sigOf),
  };
}

async function launchpadDetail(
  factory: Address,
  displayName: string,
  attributed: Attribution[],
): Promise<LaunchpadRecord> {
  h2(`Launchpad: ${displayName}  ${factory}`);

  const info = await api<AddrInfo>(`/v2/addresses/${factory}`);
  let contract = await api<ContractInfo>(`/v2/smart-contracts/${factory}`);

  // EIP-1967 proxies expose an empty ABI at the proxy address — the trade surface
  // lives on the implementation. Reading the proxy alone would report "no buy/sell
  // functions" for every upgradeable launchpad, which is exactly backwards.
  let implNote = '';
  const implAddr = info?.implementations?.[0]?.address ?? info?.implementations?.[0]?.address_hash ?? null;
  if (implAddr && isAddress(implAddr)) {
    const impl = await api<ContractInfo>(`/v2/smart-contracts/${getAddress(implAddr)}`);
    if (impl?.abi && impl.abi.length > (contract?.abi?.length ?? 0)) {
      implNote = `${info?.implementations?.[0]?.name ?? 'implementation'} @ ${getAddress(implAddr)}`;
      contract = impl;
    }
  }

  const abi = contract?.abi ?? null;
  const verified = !!contract?.abi;

  const rec: LaunchpadRecord = {
    name: displayName,
    factory,
    verified,
    proxy: info?.proxy_type ?? null,
    tokensAttributed: attributed.length,
    evidence: [],
    status: verified ? 'VERIFIED' : 'UNCONFIRMED',
  };
  if (contract?.compiler_version) rec.compiler = contract.compiler_version;

  console.log(`  explorer name      ${info?.name ?? '(unnamed)'}`);
  console.log(`  source             ${verified ? `verified (${contract?.compiler_version ?? '?'})` : 'NOT VERIFIED — ABI unavailable'}`);
  console.log(`  proxy              ${info?.proxy_type ?? 'none (non-upgradeable)'}`);
  if (implNote) {
    console.log(`  implementation     ${implNote}  ← ABI below is read from here, not the proxy`);
    rec.evidence.push(`proxy ${short(factory)} → implementation ${implNote}`);
  }
  console.log(`  seed tokens        ${attributed.length} of ${seeds.tokens.length}`);
  rec.evidence.push(`explorer /v2/smart-contracts/${factory} → ${verified ? 'verified source + ABI' : 'unverified'}`);

  if (!abi) {
    console.log('  ⚠ No verified ABI. Interface cannot be read from source; would need bytecode selector recovery.');
    return rec;
  }

  const cls = classifyAbi(abi);
  const launchEnabled = await callOne<boolean>(factory, fn('launchEnabled()', ['bool']), 'launchEnabled');
  const feeWei = await callOne<bigint>(factory, fn('launchFee()', ['uint256']), 'launchFee');
  rec.launchOpen = launchEnabled;
  rec.launchFeeWei = feeWei !== null ? feeWei.toString() : null;

  if (launchEnabled !== null) console.log(`  launchEnabled()    ${launchEnabled}`);
  if (feeWei !== null) console.log(`  launchFee()        ${formatEther(feeWei)} ETH`);

  console.log(`  buy/sell fns       ${cls.buySell.length ? cls.buySell.join(', ') : 'NONE on the factory'}`);
  console.log(`  quote views        ${cls.quoteViews.length ? cls.quoteViews.join(', ') : 'none'}`);
  console.log(`  graduation surface ${cls.graduation.length ? cls.graduation.join(', ') : 'none'}`);
  console.log(`  membership reads   ${cls.membership.length ? cls.membership.join(', ') : 'none'}`);

  rec.graduationSignal = cls.graduation.join(', ') || 'none on factory';

  // A launchpad with no buy/sell on the factory is an *instant-pool* model: the
  // token is tradeable on a DEX from block one and there is no curve to trade
  // against. That is the single most important thing this census establishes,
  // because it decides whether nock needs a curve adapter at all.
  if (cls.buySell.length === 0) {
    rec.tradeModel = 'instant-pool (no curve — trading happens on the destination DEX from launch)';
    console.log(`  ⇒ trade model      ${rec.tradeModel}`);
  } else {
    rec.tradeModel = 'bonding-curve or direct-trade factory (buy/sell present on factory)';
    console.log(`  ⇒ trade model      ${rec.tradeModel}`);
    rec.buySellPath = cls.buySell.join(', ');
  }

  // Cheapest claims() candidate: prefer a getter on the TOKEN over a mapping read
  // on the factory — one call, no factory address needed in hot paths.
  const sample = (attributed[0]?.token as Address | undefined) ?? (await discoverSampleToken(factory));
  if (sample) {
    if (attributed.length === 0) console.log(`  sample token       ${sample} (newest contract this factory created)`);
    rec.sampleToken = sample;
    const lf = await callOne<Address>(sample, fn('launchFactory()', ['address']), 'launchFactory');
    if (lf && getAddress(lf) === factory) {
      rec.membershipCheck = 'token.launchFactory() == <factory>  — 1 static call on the token, ~2.4k gas, no state deps';
      rec.membershipEvidence = `${short(sample)}.launchFactory() → ${short(lf)} == factory ✓`;
      console.log(`  ⇒ claims() check   ${rec.membershipCheck}`);
      console.log(`     evidence         ${rec.membershipEvidence}`);
      rec.evidence.push(rec.membershipEvidence);
    } else {
      const glt = await callOne<unknown>(factory, fn('getLaunchedToken(address)', ['address'], ['address']), 'getLaunchedToken', [sample]);
      if (glt !== null) {
        rec.membershipCheck = 'factory.getLaunchedToken(token) — 1 mapping read on the factory';
        rec.membershipEvidence = `${short(factory)}.getLaunchedToken(${short(sample)}) returned non-empty`;
        console.log(`  ⇒ claims() check   ${rec.membershipCheck}`);
        rec.evidence.push(rec.membershipEvidence);
      } else {
        console.log('  ⇒ claims() check   UNRESOLVED — needs a targeted read (see DATA_SOURCES.md)');
      }
    }
  }

  return rec;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Graduated / DEX path — pool, router, quoter, and a real eth_call quote
// ─────────────────────────────────────────────────────────────────────────────

const V3_POOL_ABI = {
  token0: fn('token0()', ['address']),
  token1: fn('token1()', ['address']),
  fee: fn('fee()', ['uint24']),
  liquidity: fn('liquidity()', ['uint128']),
  slot0: fn('slot0()', ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool']),
};

const QUOTER_V2_ABI = [
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
] as const satisfies Abi;

/** Which router do real users actually send through for this token? Evidence, not assumption. */
async function discoverRouters(token: Address): Promise<{ address: Address; name: string; verified: boolean; txs: string[] }[]> {
  const transfers = await api<{ items: { method?: string | null; transaction_hash?: string; tx_hash?: string }[] }>(
    `/v2/tokens/${token}/transfers`,
  );
  const hashes = [
    ...new Set((transfers?.items ?? []).map((t) => t.transaction_hash ?? t.tx_hash).filter((h): h is string => !!h)),
  ].slice(0, 12);

  const found = new Map<string, { address: Address; name: string; verified: boolean; txs: string[] }>();
  for (const h of hashes) {
    const tx = await api<TxInfo>(`/v2/transactions/${h}`);
    const to = tx?.to?.hash;
    if (!to || !isAddress(to)) continue;
    const addr = getAddress(to);
    // Skip the token and the launchpad's own plumbing; we want trade entrypoints.
    if (addr === getAddress(token)) continue;
    const entry = found.get(addr) ?? { address: addr, name: tx?.to?.name ?? '(unnamed)', verified: !!tx?.to?.is_verified, txs: [] };
    if (entry.txs.length < 2) entry.txs.push(h);
    found.set(addr, entry);
    await sleep(80);
  }
  return [...found.values()];
}

/**
 * A launchpad with no seed tokens still needs a sample to probe. Take the most
 * recent contract the factory actually created, straight from its internal txs.
 */
async function discoverSampleToken(factory: Address): Promise<Address | null> {
  const internals = await api<{ items: { type?: string; created_contract?: { hash?: string } }[] }>(
    `/v2/addresses/${factory}/internal-transactions`,
  );
  for (const it of internals?.items ?? []) {
    const hash = it.created_contract?.hash;
    if (!/create/i.test(it.type ?? '') || !hash || !isAddress(hash)) continue;
    // Keep it only if it behaves like an ERC-20.
    const dec = await callOne<number>(getAddress(hash), fn('decimals()', ['uint8']), 'decimals');
    if (dec !== null) return getAddress(hash);
  }
  return null;
}

/**
 * When a token has no pool, its trades still have to route through something.
 * Report the named contract counterparties so the venue is identified rather
 * than left blank — e.g. a bonding adapter rather than an AMM pool.
 */
async function namedCounterparties(token: Address): Promise<{ address: Address; name: string }[]> {
  const transfers = await api<{ items: { to?: { hash?: string; name?: string | null; is_contract?: boolean }; from?: { hash?: string; name?: string | null; is_contract?: boolean } }[] }>(
    `/v2/tokens/${token}/transfers`,
  );
  const out = new Map<string, { address: Address; name: string }>();
  for (const t of transfers?.items ?? []) {
    for (const side of [t.to, t.from]) {
      if (!side?.hash || !isAddress(side.hash) || !side.is_contract) continue;
      const addr = getAddress(side.hash);
      if (addr === getAddress(token)) continue;
      out.set(addr, { address: addr, name: side.name ?? '(unnamed)' });
    }
  }
  return [...out.values()];
}

/**
 * Resolve a token's pool without knowing its launchpad: walk real transfer
 * counterparties and keep the first contract that answers token0()/token1() with
 * our token on one side. Works for V2 and V3 alike, and needs no factory address.
 */
async function resolvePoolByTransfers(token: Address): Promise<Address | null> {
  const transfers = await api<{ items: { to?: { hash?: string }; from?: { hash?: string } }[] }>(
    `/v2/tokens/${token}/transfers`,
  );
  const seen = new Set<string>();
  for (const t of transfers?.items ?? []) {
    for (const cand of [t.to?.hash, t.from?.hash]) {
      if (!cand || !isAddress(cand)) continue;
      const addr = getAddress(cand);
      if (addr === getAddress(token) || seen.has(addr)) continue;
      seen.add(addr);
      const [t0, t1] = await Promise.all([
        callOne<Address>(addr, V3_POOL_ABI.token0, 'token0'),
        callOne<Address>(addr, V3_POOL_ABI.token1, 'token1'),
      ]);
      if (!t0 || !t1) continue;
      if (getAddress(t0) === getAddress(token) || getAddress(t1) === getAddress(token)) return addr;
    }
  }
  return null;
}

/** Find a QuoterV2 whose factory() equals the pool's factory. Binding, not naming. */
async function findQuoterForFactory(dexFactory: Address): Promise<Address | null> {
  const search = await api<{ items: { type: string; address?: string; address_hash?: string; name?: string }[] }>(
    `/v2/search?q=QuoterV2`,
  );
  const candidates = (search?.items ?? [])
    .filter((i) => i.type === 'contract')
    .map((i) => i.address ?? i.address_hash)
    .filter((a): a is string => !!a && isAddress(a))
    .map((a) => getAddress(a));

  for (const c of candidates) {
    const f = await callOne<Address>(c, fn('factory()', ['address']), 'factory');
    if (f && getAddress(f) === dexFactory) return c;
  }
  return null;
}

async function graduatedPath(rec: LaunchpadRecord): Promise<void> {
  const token = rec.sampleToken as Address | undefined;
  if (!token) return;

  h2(`Trading path for ${rec.name} — sample token ${short(token)}`);

  let pool = await callOne<Address>(token, fn('liquidityPool()', ['address']), 'liquidityPool');
  const pair = await callOne<Address>(token, fn('pairToken()', ['address']), 'pairToken');
  let poolFee = await callOne<number>(token, fn('poolFee()', ['uint24']), 'poolFee');
  let dexFactoryOnToken = await callOne<Address>(token, fn('dexFactory()', ['address']), 'dexFactory');

  if (!pool) {
    console.log('  token exposes no liquidityPool() — resolving the pool from real transfer counterparties instead');
    pool = await resolvePoolByTransfers(token);
    if (pool) console.log(`  pool (discovered)  ${pool}`);
  }
  if (!pool) {
    console.log('  no AMM pool — this venue trades against a contract, not a pool. Counterparties seen:');
    const cps = await namedCounterparties(token);
    table(['address', 'explorer name'], cps.map((c) => [c.address, c.name]));
    rec.destinationDex = `no AMM pool; trades route through ${cps.map((c) => c.name).filter((n) => n !== '(unnamed)').join(', ') || 'unnamed contracts'}`;
    rec.quoteMethod = 'UNRESOLVED — needs the venue contract ABI (see DATA_SOURCES.md)';
    rec.evidence.push(`no pool for ${short(token)}; counterparties: ${cps.map((c) => `${c.name} ${short(c.address)}`).join(', ')}`);
    return;
  }
  // A discovered pool tells us its own fee tier and factory; prefer those.
  poolFee ??= await callOne<number>(pool, V3_POOL_ABI.fee, 'fee');
  dexFactoryOnToken ??= await callOne<Address>(pool, fn('factory()', ['address']), 'factory');
  rec.samplePool = pool;
  console.log(`  pool               ${pool}`);
  console.log(`  pair token         ${pair ?? '?'}${pair && getAddress(pair) === getAddress(WETH) ? '  (WETH ✓)' : ''}`);
  console.log(`  pool fee           ${poolFee !== null ? `${poolFee} (${poolFee / 10_000}%)` : '?'}`);

  // Confirm the pool really is a Uniswap V3 pool by reading the V3 interface.
  const [t0, t1, feeOnPool, liq, slot0] = await Promise.all([
    callOne<Address>(pool, V3_POOL_ABI.token0, 'token0'),
    callOne<Address>(pool, V3_POOL_ABI.token1, 'token1'),
    callOne<number>(pool, V3_POOL_ABI.fee, 'fee'),
    callOne<bigint>(pool, V3_POOL_ABI.liquidity, 'liquidity'),
    callOne<readonly unknown[]>(pool, V3_POOL_ABI.slot0, 'slot0'),
  ]);

  const isV3 = t0 !== null && t1 !== null && feeOnPool !== null && slot0 !== null;
  console.log(`  pool interface     ${isV3 ? `Uniswap V3 ✓ (token0/token1/fee/slot0 all read)` : 'NOT V3 — different AMM'}`);
  if (isV3) {
    console.log(`  in-range liquidity ${liq}`);
    rec.destinationDex = `Uniswap V3 (fee ${feeOnPool}), factory ${dexFactoryOnToken ?? 'unknown'}`;
    rec.evidence.push(`pool ${short(pool)} answers the full V3 interface; fee=${feeOnPool}`);
  }

  // Routers, from real swap transactions.
  const routers = await discoverRouters(token);
  if (routers.length > 0) {
    console.log('\n  routers observed carrying real trades for this token:');
    table(
      ['address', 'explorer name', 'source', 'evidence tx'],
      routers.map((r) => [r.address, r.name, r.verified ? 'verified' : 'unverified', r.txs[0] ? short(r.txs[0]) : '—']),
    );
    report.routers.push(...routers.map((r) => ({ venue: rec.name, ...r })));
  }

  // A real quote, by eth_call simulation only.
  if (isV3 && dexFactoryOnToken && poolFee !== null) {
    const quoter = await findQuoterForFactory(getAddress(dexFactoryOnToken));
    if (!quoter) {
      console.log('\n  ⚠ no QuoterV2 binds to this DEX factory — quoting would use slot0 math or a router simulation.');
      rec.quoteMethod = 'UNRESOLVED — no QuoterV2 bound to this factory';
      return;
    }
    console.log(`\n  QuoterV2           ${quoter}  (factory() == token.dexFactory() ✓)`);

    const ethIn = 10n ** 15n; // 0.001 ETH — a read-only probe amount, nothing is sent.
    const res = await (async () => {
      try {
        const { result } = await client.simulateContract({
          address: quoter,
          abi: QUOTER_V2_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn: WETH, tokenOut: token, amountIn: ethIn, fee: poolFee, sqrtPriceLimitX96: 0n }],
        });
        return result;
      } catch (e) {
        console.log(`  quote reverted: ${(e as Error).message.split('\n')[0]}`);
        return null;
      }
    })();

    if (res) {
      const [amountOut, , ticks, gasEstimate] = res as readonly [bigint, bigint, number, bigint];
      console.log(`  ⇒ QUOTE (eth_call) 0.001 ETH → ${formatEther(amountOut)} ${rec.name} token`);
      console.log(`     ticks crossed    ${ticks} · gas estimate ${gasEstimate}`);
      rec.quoteMethod = `QuoterV2.quoteExactInputSingle via eth_call (${quoter})`;
      rec.evidence.push(`eth_call quote 0.001 ETH → ${formatEther(amountOut)} tokens on ${short(pool)}`);
      report.quotes.push({
        venue: rec.name,
        token,
        pool,
        quoter,
        amountInWei: ethIn.toString(),
        amountOutWei: amountOut.toString(),
        amountOut: formatEther(amountOut),
        method: 'eth_call simulation (read-only)',
      });
    }
  }
}

const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');

// ─────────────────────────────────────────────────────────────────────────────
// 5. Summary
// ─────────────────────────────────────────────────────────────────────────────

function summary(): void {
  h1('5 · CENSUS SUMMARY');

  table(
    ['launchpad', 'factory', 'toks', 'source', 'model', 'claims() check', 'status'],
    report.launchpads.map((l) => [
      l.name,
      short(l.factory),
      String(l.tokensAttributed),
      l.verified ? 'verified' : 'unverified',
      (l.tradeModel ?? '?').split(' (')[0] ?? '?',
      l.membershipCheck ? (l.membershipCheck.split('—')[0] ?? '').trim() : 'unresolved',
      l.status,
    ]),
  );

  h2('Trading path per launchpad');
  table(
    ['launchpad', 'destination DEX', 'quote method'],
    report.launchpads.map((l) => [l.name, l.destinationDex ?? '—', l.quoteMethod ?? '—']),
  );

  if (report.routers.length > 0) {
    h2('Routers carrying real trades (evidence-derived)');
    const uniq = new Map<string, Record<string, unknown>>();
    for (const r of report.routers) uniq.set(String(r['address']), r);
    table(
      ['address', 'name', 'source'],
      [...uniq.values()].map((r) => [String(r['address']), String(r['name']), r['verified'] ? 'verified' : 'unverified']),
    );
  }

  h2('Safety');
  console.log('  transactions sent this run: 0 (this script has no signer and no send path)');
  console.log('  calls used: eth_chainId, eth_blockNumber, eth_gasPrice, eth_getBlockByNumber, eth_call + explorer GETs');
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('nock · Robinhood Chain launchpad census — READ-ONLY (no signer, no send path)');

  await chainSanity();

  const { factories } = await censusByCreationTrace();
  const knownNames = await censusByKnownCandidates(new Set(factories.keys()));

  h1('3 · PER-LAUNCHPAD DETAIL');

  // Every factory that actually deployed seed tokens, busiest first, plus any
  // harvested candidate that did not appear in the trace (so a dead or paused
  // launchpad is still reported rather than silently dropped).
  const ordered = [...factories.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [factory, toks] of ordered) {
    const addr = getAddress(factory);
    const info = await api<AddrInfo>(`/v2/addresses/${addr}`);
    const name = knownNames.get(addr) ?? info?.name ?? `unknown-${short(addr)}`;
    const rec = await launchpadDetail(addr, name, toks);
    report.launchpads.push(rec);
  }

  for (const cand of seeds.knownFactoryCandidates) {
    const addr = getAddress(cand.address);
    if (factories.has(addr)) continue;
    const rec = await launchpadDetail(addr, `${cand.name} (no seed tokens)`, []);
    report.launchpads.push(rec);
  }

  h1('4 · GRADUATED / DEX TRADING PATH');
  for (const rec of report.launchpads) {
    if (rec.sampleToken) await graduatedPath(rec);
  }

  summary();

  const outDir = resolve(HERE, 'out');
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, 'census.json');
  writeFileSync(outFile, JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  console.log(`\n  census written to ${outFile}`);
}

main().catch((e: unknown) => {
  console.error('\nrecon failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
