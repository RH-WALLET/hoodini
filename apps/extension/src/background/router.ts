/**
 * Message router — the service worker's front door.
 *
 * Enforces the surface policy in one place, then dispatches. Handlers never see
 * a message they are not allowed to serve, so no handler has to remember the
 * rule and none can weaken it locally.
 */

import {
  KeystoreError,
  KeystoreSession,
  changePassword,
  createRandomVault,
  createVault,
  exportPrivateKey,
  DEFAULT_AUTO_LOCK_MS,
} from '@hoodini/core';
import type { KdfParams } from '@hoodini/core';
import type { VaultStore } from './storage.js';
import { isAllowed, type Request, type Response, type Surface, type WalletStatus } from './protocol.js';

export interface RouterDeps {
  readonly store: VaultStore;
  readonly session: KeystoreSession;
  readonly autoLockMs?: number;
  /** Test seam only. Production always uses the module default (D-022). */
  readonly kdf?: Omit<KdfParams, 'salt'>;
}

function fail(code: string, message: string): Response<never> {
  return { ok: false, error: { code, message } };
}

/** Never let an internal message reach the UI verbatim — it may quote inputs. */
function toError(e: unknown): Response<never> {
  if (e instanceof KeystoreError) return fail(e.code, e.message);
  return fail('INTERNAL', 'the operation failed');
}

export function createRouter(deps: RouterDeps) {
  const { store, session, kdf } = deps;
  const autoLockMs = deps.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;

  async function status(): Promise<WalletStatus> {
    const vault = await store.read();
    return {
      hasVault: vault !== null,
      address: vault?.address ?? null,
      isUnlocked: session.isUnlocked,
      autoLockMs,
    };
  }

  return async function handle(request: Request, surface: Surface | null): Promise<Response> {
    // An unknown or foreign sender gets nothing, not even a status read.
    if (surface === null) return fail('FORBIDDEN', 'unrecognised sender');
    if (!request || typeof request.type !== 'string') return fail('BAD_REQUEST', 'malformed message');
    if (!isAllowed(request.type, surface)) {
      return fail('FORBIDDEN', `${request.type} is not available to ${surface}`);
    }

    try {
      switch (request.type) {
        case 'wallet.status':
          return { ok: true, data: await status() };

        case 'wallet.create': {
          // Refuse rather than overwrite: silently replacing a vault would
          // destroy funds if the user still had a balance on the old key.
          if (await store.exists()) return fail('VAULT_EXISTS', 'a wallet already exists; reset it first');
          const { vault } = await createRandomVault(request.password, kdf);
          await store.write(vault);
          return { ok: true, data: { address: vault.address } };
        }

        case 'wallet.import': {
          if (await store.exists()) return fail('VAULT_EXISTS', 'a wallet already exists; reset it first');
          const vault = await createVault(request.privateKey, request.password, kdf);
          await store.write(vault);
          return { ok: true, data: { address: vault.address } };
        }

        case 'wallet.unlock': {
          const vault = await store.read();
          if (!vault) return fail('NO_VAULT', 'no wallet has been created yet');
          const address = await session.unlock(vault, request.password);
          return { ok: true, data: { address } };
        }

        case 'wallet.lock':
          session.lock();
          return { ok: true, data: {} };

        case 'wallet.export': {
          const vault = await store.read();
          if (!vault) return fail('NO_VAULT', 'no wallet has been created yet');
          // Requires the password again even when unlocked: revealing a key is
          // the one action an idle unlocked session must not authorise.
          const privateKey = await exportPrivateKey(vault, request.password);
          return { ok: true, data: { privateKey } };
        }

        case 'wallet.changePassword': {
          const vault = await store.read();
          if (!vault) return fail('NO_VAULT', 'no wallet has been created yet');
          const next = await changePassword(vault, request.currentPassword, request.newPassword, kdf);
          await store.write(next);
          // The old derived key is gone; force a fresh unlock.
          session.lock();
          return { ok: true, data: { address: next.address } };
        }

        case 'wallet.reset': {
          const vault = await store.read();
          if (!vault) return fail('NO_VAULT', 'no wallet has been created yet');
          // Proving the password before destroying the vault stops a shoulder
          // -surfer or a stray click from wiping a funded wallet.
          await exportPrivateKey(vault, request.password);
          session.lock();
          await store.clear();
          return { ok: true, data: {} };
        }

        default:
          return fail('BAD_REQUEST', 'unknown message type');
      }
    } catch (e) {
      return toError(e);
    }
  };
}
