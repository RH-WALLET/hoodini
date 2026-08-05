/**
 * Typed wrapper around chrome.runtime.sendMessage.
 *
 * Throws on a failed response so callers use try/catch rather than checking a
 * flag they might forget.
 */

import type { Request, Response, WalletStatus } from '../background/protocol.js';
import type { Address, Hex } from 'viem';
import type { Settings } from '@hoodini/core';

async function send<T>(request: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
  if (!res) throw new Error('the extension did not respond');
  if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data;
}

export const wallet = {
  status: () => send<WalletStatus>({ type: 'wallet.status' }),
  create: (password: string) => send<{ address: Address }>({ type: 'wallet.create', password }),
  import: (password: string, privateKey: Hex) => send<{ address: Address }>({ type: 'wallet.import', password, privateKey }),
  unlock: (password: string) => send<{ address: Address }>({ type: 'wallet.unlock', password }),
  lock: () => send<Record<string, never>>({ type: 'wallet.lock' }),
  exportKey: (password: string) => send<{ privateKey: Hex }>({ type: 'wallet.export', password }),
  reset: (password: string) => send<Record<string, never>>({ type: 'wallet.reset', password }),
};

export interface PositionRow {
  readonly token: Address;
  readonly symbol: string | null;
  readonly balanceFormatted: string;
  readonly valueWei: string | null;
  readonly valueUnavailableReason: string | null;
  readonly venueId: string | null;
}

export interface PositionsResult {
  readonly positions: readonly PositionRow[];
  readonly totalWei: string;
  readonly valued: number;
  readonly unvalued: number;
}

export const positions = {
  list: () => send<PositionsResult>({ type: 'positions.list' }),
};

export const settings = {
  get: () => send<Settings>({ type: 'settings.get' }),
  /**
   * Broadcasts after a successful save so open tabs redraw their overlays
   * without a reload. The send is fire-and-forget: with no tab listening,
   * `sendMessage` rejects, and a settings save must not report failure because
   * nobody happened to be looking at a terminal.
   */
  set: async (next: Settings): Promise<Settings> => {
    const saved = await send<Settings>({ type: 'settings.set', settings: next });
    chrome.runtime.sendMessage({ type: 'settings.changed' }).catch(() => {});
    return saved;
  },
};

export interface PendingTradeRow {
  readonly id: string;
  readonly side: 'buy' | 'sell';
  readonly token: Address;
  readonly amount?: string;
  readonly slippageBps: number;
  readonly origin: string;
  readonly createdAt: number;
}

export const trades = {
  pending: () => send<{ request: PendingTradeRow | null }>({ type: 'trade.pending' }),
  approve: (id: string) => send<unknown>({ type: 'trade.approve', id }),
  reject: () => send<Record<string, never>>({ type: 'trade.reject' }),
  quote: (side: 'buy' | 'sell', token: Address, amount: string | undefined, slippageBps: number) =>
    send<{ out?: string; quoteAsset?: string; venueId?: string }>({
      type: 'trade.quote',
      side,
      token,
      ...(amount !== undefined ? { amount } : {}),
      slippageBps,
    }),
};

export interface WithdrawOutcome {
  readonly status: 'sent' | 'simulated';
  readonly to: Address;
  readonly valueWei: string;
  readonly hash?: string;
}

export const withdrawApi = {
  /** `amount` is wei as a decimal string, or 'max' to sweep. */
  send: (to: string, amount: string) => send<WithdrawOutcome>({ type: 'wallet.withdraw', to, amount }),
};
