/**
 * scripts/discover.ts — find live venues by traffic, not by name.
 *
 * Name search is unreliable on this chain: copycat tokens squat protocol names
 * and real protocol contracts are often unnamed or unverified. So instead of
 * asking "what is called Pons", this asks "what is the chain actually busy
 * with" — sample recent blocks, rank destination addresses by transaction
 * count, then identify the top ones.
 *
 * READ-ONLY. No signer. eth_getBlockByNumber + eth_call + explorer GETs only.
 *
 *   pnpm discover [blocks]      # default 600 blocks (~60s of chain at 0.1s/block)
 */

import { createPublicClient, defineChain, http, getAddress, isAddress, type Abi, type Address } from 'viem';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env['RPC_URL'] ?? 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = Number(process.env['CHAIN_ID'] ?? 4663);
const EXPLORER_API = process.env['EXPLORER_API'] ?? 'https://robinhoodchain.blockscout.com/api';
const SAMPLE = Number(process.argv[2] ?? 600);

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const client = createPublicClient({ chain, transport: http(RPC_URL) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

interface AddrInfo {
  name: string | null;
  is_contract: boolean;
  is_verified: boolean;
  proxy_type: string | null;
  implementations: { address?: string; address_hash?: string; name?: string | null }[];
  token?: { symbol?: string; name?: string } | null;
}
interface ContractInfo {
  name: string | null;
  abi?: Abi | null;
  compiler_version?: string;
}

function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) return void console.log('  (none)');
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (c: string[]) => '  ' + c.map((x, i) => (x ?? '').padEnd(w[i] ?? 0)).join('  ');
  console.log(line(headers));
  console.log('  ' + w.map((n) => '─'.repeat(n)).join('  '));
  rows.forEach((r) => console.log(line(r)));
}

async function main(): Promise<void> {
  const head = await client.getBlockNumber();
  console.log(`Sampling ${SAMPLE} blocks ending at ${head} on chain ${CHAIN_ID} — read-only.\n`);

  // 1. Tally destination addresses across the sample.
  const hits = new Map<string, number>();
  const selectors = new Map<string, Map<string, number>>();
  let txTotal = 0;
  let creations = 0;

  const CONC = 12;
  for (let off = 0; off < SAMPLE; off += CONC) {
    const nums = Array.from({ length: Math.min(CONC, SAMPLE - off) }, (_, i) => head - BigInt(off + i));
    const blocks = await Promise.all(
      nums.map((n) => client.getBlock({ blockNumber: n, includeTransactions: true }).catch(() => null)),
    );
    for (const b of blocks) {
      if (!b) continue;
      for (const tx of b.transactions) {
        if (typeof tx === 'string') continue;
        txTotal++;
        if (!tx.to) {
          creations++;
          continue;
        }
        const to = getAddress(tx.to);
        hits.set(to, (hits.get(to) ?? 0) + 1);
        const sel = (tx.input ?? '0x').slice(0, 10);
        if (sel.length === 10) {
          const m = selectors.get(to) ?? new Map<string, number>();
          m.set(sel, (m.get(sel) ?? 0) + 1);
          selectors.set(to, m);
        }
      }
    }
    process.stdout.write(`\r  scanned ${Math.min(off + CONC, SAMPLE)}/${SAMPLE} blocks · ${txTotal} txs`);
  }
  console.log(`\n\n  ${txTotal} transactions, ${hits.size} distinct destinations, ${creations} raw deploys.\n`);

  // 2. Identify the busiest destinations.
  const top = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const rows: string[][] = [];
  const detail: Record<string, unknown>[] = [];

  for (const [addr, count] of top) {
    const info = await api<AddrInfo>(`/v2/addresses/${addr}`);
    const implAddr = info?.implementations?.[0]?.address ?? info?.implementations?.[0]?.address_hash ?? null;
    let name = info?.name ?? '(unnamed)';
    let abiSource = addr;
    if (implAddr && isAddress(implAddr)) {
      name = `${name} → ${info?.implementations?.[0]?.name ?? 'impl'}`;
      abiSource = getAddress(implAddr);
    }
    const contract = await api<ContractInfo>(`/v2/smart-contracts/${abiSource}`);
    const abi = contract?.abi ?? null;
    const fns = (abi ?? []).filter((e): e is Extract<Abi[number], { type: 'function' }> => e.type === 'function');

    // Does this look like a trading venue?
    const trade = fns.filter((f) => /^(buy|sell|swap|exactInput|exactOutput)/i.test(f.name)).map((f) => f.name);
    const launch = fns.filter((f) => /^(launch|deploy|create|newToken|mint)/i.test(f.name)).map((f) => f.name);
    const curve = fns.filter((f) => /(curve|bond|graduat|migrat|reserve)/i.test(f.name)).map((f) => f.name);

    const kind = [
      trade.length ? 'TRADE' : '',
      launch.length ? 'LAUNCH' : '',
      curve.length ? 'CURVE' : '',
      info?.token ? 'token' : '',
    ]
      .filter(Boolean)
      .join('+') || (info?.is_contract ? 'contract' : 'EOA');

    rows.push([
      String(count),
      `${((count / txTotal) * 100).toFixed(1)}%`,
      addr,
      name.slice(0, 40),
      contract?.abi ? 'verified' : 'unverified',
      kind,
    ]);
    detail.push({ address: addr, txs: count, name, kind, trade, launch, curve });
    await sleep(80);
  }

  console.log('TOP DESTINATIONS BY TRANSACTION COUNT\n');
  table(['txs', 'share', 'address', 'name', 'source', 'looks like'], rows);

  // 3. Anything that trades or runs a curve is a venue candidate.
  const venues = detail.filter((d) => {
    const k = String(d['kind']);
    return k.includes('TRADE') || k.includes('CURVE') || k.includes('LAUNCH');
  });
  if (venues.length > 0) {
    console.log('\nVENUE CANDIDATES — trade / curve / launch surface present\n');
    for (const v of venues) {
      console.log(`  ${v['address']}  ${v['name']}  (${v['txs']} txs)`);
      const t = v['trade'] as string[];
      const c = v['curve'] as string[];
      const l = v['launch'] as string[];
      if (t.length) console.log(`     trade:  ${t.join(', ')}`);
      if (c.length) console.log(`     curve:  ${c.join(', ')}`);
      if (l.length) console.log(`     launch: ${l.join(', ')}`);
    }
  }

  const outDir = resolve(HERE, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, 'discover.json'),
    JSON.stringify({ head: head.toString(), sampled: SAMPLE, txTotal, top: detail }, null, 2) + '\n',
  );
  console.log(`\n  written to ${resolve(outDir, 'discover.json')}`);
}

main().catch((e: unknown) => {
  console.error('discover failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
