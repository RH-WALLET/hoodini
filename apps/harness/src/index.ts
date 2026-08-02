/**
 * @hoodini/harness — exercise the venue stack against the live chain, read-only.
 *
 * Resolves a CA to its venue, quotes both directions, and prints the calldata a
 * trade WOULD send — then simulates that calldata via eth_call so a broken
 * encoding fails here rather than on someone's money.
 *
 * There is no signer in this process and no broadcast path. `eth_call` from a
 * zero-balance address is the only execution that happens.
 *
 *   pnpm --filter @hoodini/harness start <tokenAddress> [ethIn] [slippageBps]
 */

import { formatEther, isAddress, getAddress, parseEther, type Address } from 'viem';
import {
  createChainClient,
  UniswapV3Adapter,
  DopplerAdapter,
  VenueRouter,
  SWAP_ROUTER_02,
  type TokenRef,
  type TxRequest,
} from '@hoodini/core';

const RPC_URL = process.env['RPC_URL'];
const LIVE_TRADING = process.env['LIVE_TRADING'] === 'true';

function usage(): never {
  console.error('usage: pnpm --filter @hoodini/harness start <tokenAddress> [ethIn] [slippageBps]');
  console.error('   eg: pnpm --filter @hoodini/harness start 0xB84e494158976B4e14da155d1cdaE16EB6D1C477 0.001 100');
  process.exit(1);
}

const h = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 66 - s.length))}`);

async function main(): Promise<void> {
  const [rawToken, rawEth = '0.001', rawSlippage = '100'] = process.argv.slice(2);
  if (!rawToken || !isAddress(rawToken)) usage();

  const ethIn = parseEther(rawEth);
  const slippageBps = Number(rawSlippage);

  console.log('Hoodini harness — READ-ONLY (no signer, no broadcast path)');
  if (LIVE_TRADING) {
    // The harness has nothing to gate, but a stray LIVE_TRADING=true in the
    // environment is worth surfacing loudly wherever it appears.
    console.log('  note: LIVE_TRADING=true is set in the environment. It changes NOTHING here —');
    console.log('        this process cannot sign or broadcast. Unset it to avoid confusion.');
  }

  const client = createChainClient(RPC_URL);
  const adapter = new UniswapV3Adapter(client);
  const doppler = new DopplerAdapter(client);
  const router = new VenueRouter([adapter, doppler], undefined, client);

  const token: TokenRef = { address: getAddress(rawToken), chainId: await client.getChainId() };

  h('resolve');
  const resolution = await router.resolve(token);
  if (!resolution) {
    console.log(`  no adapter claims ${token.address} — unsupported venue.`);
    console.log('  (this is the correct outcome for an unknown venue: never guess a router)');
    process.exit(2);
  }
  console.log(`  token     ${token.address}`);
  console.log(`  venue     ${resolution.adapter.id}   (attributed via ${resolution.via})`);
  console.log(`  state     ${await resolution.adapter.state(token)}`);

  h(`quote buy — ${formatEther(ethIn)} ETH`);
  const buyQuote = await resolution.adapter.quoteBuy(token, ethIn);
  console.log(`  amountOut ${formatEther(buyQuote.amountOut)} tokens`);
  console.log(
    `  venue fee ${buyQuote.feeBps === null ? 'dynamic (set per swap by the hook)' : `${buyQuote.feeBps} bps`}   (Hoodini adds 0)`,
  );
  console.log(`  source    ${buyQuote.source}`);

  h(`build buy — ${slippageBps} bps slippage`);
  const buyTx = await tryBuild(() => resolution.adapter.buildBuy(token, ethIn, slippageBps));
  if (!buyTx) {
    // A venue whose read path works but whose write path is unfinished is a
    // valid, expected state — report it plainly rather than crashing.
    h('safety');
    console.log('  quote path verified; write path not implemented for this venue yet');
    console.log('  transactions sent: 0');
    return;
  }
  console.log(`  to        ${buyTx.to}${buyTx.to === SWAP_ROUTER_02 ? '  (SwapRouter02 ✓)' : '  ⚠ NOT the verified router'}`);
  console.log(`  value     ${formatEther(buyTx.value)} ETH`);
  console.log(`  data      ${buyTx.data.slice(0, 74)}…  (${(buyTx.data.length - 2) / 2} bytes)`);
  console.log(`  ${buyTx.description}`);

  // Simulate the exact calldata. A zero-balance sender proves the encoding is
  // valid; it will fail on funds, not on shape.
  h('simulate buy calldata (eth_call)');
  await simulate(client, buyTx, '0x0000000000000000000000000000000000000003');

  // Sell path, sized from what the buy would produce.
  const sellAmount = buyQuote.amountOut;
  h(`quote sell — ${formatEther(sellAmount)} tokens (round trip)`);
  const sellQuote = await resolution.adapter.quoteSell(token, sellAmount);
  console.log(`  amountOut ${formatEther(sellQuote.amountOut)} ETH`);
  const roundTripBps = Number((sellQuote.amountOut * 10_000n) / ethIn);
  console.log(`  round trip ${(roundTripBps / 100).toFixed(2)}% of input back (two 1% fees + impact ≈ expected)`);

  h(`build sell — ${slippageBps} bps slippage`);
  const sellTx = await resolution.adapter.buildSell(token, sellAmount, slippageBps);
  console.log(`  to        ${sellTx.to}`);
  console.log(`  value     ${formatEther(sellTx.value)} ETH  (sells send no ETH)`);
  console.log(`  data      ${sellTx.data.slice(0, 74)}…  (${(sellTx.data.length - 2) / 2} bytes)`);
  console.log(`  ${sellTx.description}`);

  h('approval check');
  const owner = '0x0000000000000000000000000000000000000003' as Address;
  const approval = await resolution.adapter.approvalNeeded(token, owner, sellAmount);
  console.log(
    approval
      ? `  needed → approve exactly ${sellAmount} to ${SWAP_ROUTER_02}`
      : '  none needed (allowance already sufficient)',
  );

  h('safety');
  console.log('  transactions sent: 0 — this process has no signer and no broadcast path');
  console.log(`  calldata targets:  ${[...new Set([buyTx.to, sellTx.to, approval?.to].filter(Boolean))].join(', ')}`);
}

/** eth_call the built calldata and report what actually happens. */
async function simulate(
  client: ReturnType<typeof createChainClient>,
  tx: { to: Address; data: `0x${string}`; value: bigint },
  from: Address,
): Promise<void> {
  try {
    await client.call({ account: from, to: tx.to, data: tx.data, value: tx.value });
    console.log('  ✓ calldata executes (would succeed given funds)');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const first = msg.split('\n').find((l) => /reason|revert|Error:/i.test(l))?.trim() ?? msg.split('\n')[0];
    // A zero-balance caller failing on funds proves the shape is right; a
    // decode/selector failure would mean the encoding itself is wrong.
    const fundsRelated = /insufficient|balance|exceeds|STF|funds/i.test(msg);
    console.log(`  ${fundsRelated ? '✓' : '⚠'} ${first}`);
    if (fundsRelated) console.log('    (expected — the simulated sender holds no ETH; encoding is valid)');
  }
}

main().catch((e: unknown) => {
  console.error('\nharness failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});

/** Returns null when the adapter's write path is deliberately unimplemented. */
async function tryBuild(fn: () => Promise<TxRequest>): Promise<TxRequest | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && e.name === 'NotImplementedError') {
      console.log(`  ⏸ ${e.message}`);
      return null;
    }
    throw e;
  }
}
