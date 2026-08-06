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

export interface ChainStats {
  readonly coinPriceUsd: number | null;
  readonly gasGwei: number | null;
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

export interface ApprovalRow {
  readonly token: Address;
  readonly symbol: string | null;
  readonly spender: Address;
  readonly spenderLabel: string;
  readonly amount: string;
  readonly unlimited: boolean;
}

export const accountsApi = {
  select: (index: number) => send<WalletStatus>({ type: 'wallet.select', index }),
  add: (password: string, privateKey?: Hex) =>
    send<WalletStatus>({ type: 'wallet.addAccount', password, ...(privateKey ? { privateKey } : {}) }),
  rename: (index: number, label: string) => send<WalletStatus>({ type: 'wallet.rename', index, label }),
};

export const chainApi = {
  stats: () => send<ChainStats>({ type: 'chain.stats' }),
};

export const historyApi = {
  /** Names your address to the explorer. Called on demand, never on open. */
  list: () => send<{ rows: HistoryRow[] }>({ type: 'history.list' }),
};

export const approvalsApi = {
  list: () => send<{ rows: ApprovalRow[]; scanned: number }>({ type: 'approvals.list' }),
  revoke: (token: Address, spender: Address) =>
    send<{ status: string }>({ type: 'approvals.revoke', token, spender }),
};

export const balanceApi = {
  /** Native ETH, wei as a decimal string. Popup-only. */
  read: () => send<{ wei: string }>({ type: 'wallet.balance' }),
};

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

export interface ConsentState {
  readonly armed: boolean;
  readonly armedAt: number | null;
  /** False until a live send has happened by hand — invariant 5 (D-059). */
  readonly liveUnlocked: boolean;
  /** Whether unlocking arms it automatically. Persisted; on by default. */
  readonly autoArm: boolean;
}

export const consentApi = {
  status: () => send<ConsentState>({ type: 'consent.status' }),
  arm: () => send<ConsentState>({ type: 'consent.arm' }),
  disarm: () => send<ConsentState>({ type: 'consent.disarm' }),
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
