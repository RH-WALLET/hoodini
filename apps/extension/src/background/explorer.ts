/**
 * The block explorer, for the two things chain RPC cannot answer.
 *
 * Invariant 4 forbids a backend and permits public APIs read directly from the
 * extension. Blockscout is that: a coin price, and a list of transactions an
 * address has sent. Neither is derivable from `eth_call`, and building a server
 * to serve them would be the thing the invariant exists to prevent.
 *
 * ## The two requests are not equally private, and are not treated as such
 *
 * `/stats` carries no address. It is a global figure about the chain, so asking
 * for it discloses nothing about who is asking, and the popup fetches it freely.
 *
 * `/addresses/{a}/transactions` necessarily names the address. That tells the
 * explorer which wallet is being looked at, which is a real disclosure even
 * though no key is involved and no data of ours is sent. PRIVACY.md promises no
 * telemetry, and this is not telemetry — but it is still a third party learning
 * something, so the popup asks for it only when told to and says so on screen.
 *
 * Every response here is untrusted input. It is shaped by a server nobody in
 * this project controls, so nothing is destructured without checking and nothing
 * is rendered as a number without being parsed as one.
 */

const BASE = 'https://robinhoodchain.blockscout.com/api/v2';

/** Long enough for a slow explorer, short enough that the popup never hangs. */
const TIMEOUT_MS = 6_000;

async function get(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    // An explorer being down must degrade the popup, never break it.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ChainStats {
  /** USD per ETH, or null when the explorer did not answer with a number. */
  readonly coinPriceUsd: number | null;
  /** Gwei, the explorer's own "average" figure. Null when unavailable. */
  readonly gasGwei: number | null;
}

export async function fetchStats(): Promise<ChainStats> {
  const raw = await get('/stats');
  if (!raw || typeof raw !== 'object') return { coinPriceUsd: null, gasGwei: null };
  const o = raw as { coin_price?: unknown; gas_prices?: { average?: unknown } };

  // The price arrives as a string. Parsed rather than trusted, and rejected
  // outright if it is not a finite positive number — a NaN rendered into a
  // balance would read as a real figure of zero.
  const price = Number(o.coin_price);
  const gas = Number(o.gas_prices?.average);
  return {
    coinPriceUsd: Number.isFinite(price) && price > 0 ? price : null,
    gasGwei: Number.isFinite(gas) && gas >= 0 ? gas : null,
  };
}

export interface HistoryRow {
  readonly hash: string;
  readonly method: string | null;
  readonly to: string | null;
  readonly toName: string | null;
  readonly valueWei: string;
  readonly feeWei: string;
  readonly success: boolean;
  readonly blockNumber: number | null;
  readonly timestamp: string | null;
}

/**
 * Transactions this address has sent.
 *
 * `filter=from` deliberately: incoming transfers are somebody else's activity,
 * and a history screen that mixed them in would make it hard to answer the one
 * question it exists for, which is "what did I do".
 */
export async function fetchHistory(address: string, limit = 25): Promise<HistoryRow[] | null> {
  const raw = await get(`/addresses/${address}/transactions?filter=from`);
  if (!raw || typeof raw !== 'object') return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;

  const rows: HistoryRow[] = [];
  for (const item of items.slice(0, limit)) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t['hash'] !== 'string') continue;
    const to = t['to'] as { hash?: unknown; name?: unknown } | null | undefined;
    const fee = t['fee'] as { value?: unknown } | null | undefined;
    rows.push({
      hash: t['hash'],
      method: typeof t['method'] === 'string' ? t['method'] : null,
      to: typeof to?.hash === 'string' ? to.hash : null,
      toName: typeof to?.name === 'string' ? to.name : null,
      // Kept as strings: these are wei, and a JSON number cannot hold them.
      valueWei: typeof t['value'] === 'string' ? t['value'] : '0',
      feeWei: typeof fee?.value === 'string' ? fee.value : '0',
      success: t['status'] === 'ok',
      blockNumber: typeof t['block_number'] === 'number' ? t['block_number'] : null,
      timestamp: typeof t['timestamp'] === 'string' ? t['timestamp'] : null,
    });
  }
  return rows;
}
