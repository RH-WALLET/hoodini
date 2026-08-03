/**
 * Typed wrapper around chrome.runtime.sendMessage.
 *
 * Throws on a failed response so callers use try/catch rather than checking a
 * flag they might forget.
 */

import type { Request, Response, WalletStatus } from '../background/protocol.js';
import type { Address, Hex } from 'viem';

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
