/**
 * Chain client. Read-only by construction: this module creates a viem
 * PublicClient and nothing else. There is no WalletClient anywhere in
 * @hoodini/core — signing lives in the extension's service worker, behind the
 * LIVE_TRADING gate (CLAUDE.md invariant 5).
 */

import { createPublicClient, defineChain, http, type PublicClient } from 'viem';

export const ROBINHOOD_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export function createChainClient(rpcUrl: string = DEFAULT_RPC_URL): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) }) as PublicClient;
}
