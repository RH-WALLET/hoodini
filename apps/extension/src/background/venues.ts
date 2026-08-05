/**
 * Assembling the venue stack for the service worker.
 *
 * Every adapter the project has, wired the same way the harness wires them —
 * deliberately, because the harness is the surface that has been exercised
 * against live chain state for months and any divergence between the two would
 * mean the thing tested and the thing shipped are not the same thing.
 *
 * Read-only by construction: adapters quote and build calldata, and none of
 * them can sign. Sending lives behind `TradeEngine` and the `LIVE_TRADING`
 * build constant.
 */

import {
  DEFAULT_RPC_URL,
  DopplerAdapter,
  FlapAdapter,
  KlikAdapter,
  ROBINHOOD_CHAIN_ID,
  UniswapV3Adapter,
  V4HookAdapter,
  V4_HOOK_VENUES,
  HOOKLESS_V4_VENUE,
  VenueRouter,
  VirtualsAdapter,
  createChainClient,
} from '@hoodini/core';
import type { PublicClient } from 'viem';

export interface VenueStack {
  readonly client: PublicClient;
  readonly venues: VenueRouter;
  readonly chainId: number;
}

/**
 * The return type is annotated rather than inferred: viem's client type is deep
 * enough that TypeScript cannot name it portably from here, and an inferred
 * signature would leak paths into `node_modules` for anyone consuming this.
 */
export function createVenueStack(rpcUrl: string = DEFAULT_RPC_URL): VenueStack {
  const client = createChainClient(rpcUrl);
  const adapters = [
    new UniswapV3Adapter(client),
    new DopplerAdapter(client),
    new FlapAdapter(client),
    new KlikAdapter(client),
    new VirtualsAdapter(client),
    // Fixed-parameter V4 hooks are config, not adapters (D-045).
    ...V4_HOOK_VENUES.map((v) => new V4HookAdapter(client, v)),
    // Plain V4, no hook — 88% of pools on this chain, and the venue
    // pools.trade launches into. Last, because its claims() is the broadest
    // here and every specific venue must get the chance first.
    new V4HookAdapter(client, HOOKLESS_V4_VENUE),
  ];
  return {
    client,
    venues: new VenueRouter(adapters, undefined, client),
    chainId: ROBINHOOD_CHAIN_ID,
  };
}
