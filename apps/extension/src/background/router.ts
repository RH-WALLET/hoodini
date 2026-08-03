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
import { loadPositions, planBuy, planSell, summarise, UnsupportedVenueError, type KdfParams, type VenueRouter } from '@hoodini/core';

/** Just the one read needed to size a sell-the-whole-balance probe. */
const ERC20_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
import { getAddress, type Address } from 'viem';
import type { VaultStore } from './storage.js';
import type { TradeEngine } from './engine.js';
import { isAllowed, type Request, type Response, type Surface, type WalletStatus } from './protocol.js';

export interface RouterDeps {
  readonly store: VaultStore;
  readonly session: KeystoreSession;
  readonly autoLockMs?: number;
  /** Test seam only. Production always uses the module default (D-022). */
  readonly kdf?: Omit<KdfParams, 'salt'>;
  /** Absent until the trade surfaces are wired; their messages then report UNAVAILABLE. */
  readonly trade?: {
    readonly venues: VenueRouter;
    readonly engine: TradeEngine;
    readonly chainId: number;
    readonly client: import('viem').PublicClient;
    readonly watchlist: { list(): Promise<Address[]>; add(t: Address): Promise<void> };
  };
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
  const { store, session, kdf, trade } = deps;
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

        case 'positions.list': {
          if (!trade) return fail('UNAVAILABLE', 'trading is not wired up in this build');
          const owner = session.address;
          if (!owner) return fail('LOCKED', 'unlock to see positions');
          const tokens = await trade.watchlist.list();
          const positions = await loadPositions(tokens, {
            client: trade.client,
            router: trade.venues,
            owner,
            chainId: trade.chainId,
          });
          const totals = summarise(positions);
          return {
            ok: true,
            data: {
              positions: positions.map((p) => ({
                token: p.token,
                symbol: p.symbol,
                balanceFormatted: p.balanceFormatted,
                valueWei: p.valueWei?.toString() ?? null,
                valueUnavailableReason: p.valueUnavailableReason,
                venueId: p.venueId,
              })),
              totalWei: totals.totalWei.toString(),
              valued: totals.valued,
              // Sent to the UI so a partial total is never shown as complete.
              unvalued: totals.unvalued,
            },
          };
        }

        case 'trade.quote':
        case 'trade.execute': {
          if (!trade) return fail('UNAVAILABLE', 'trading is not wired up in this build');
          let token: Address;
          try {
            token = getAddress(request.token);
          } catch {
            // Addresses arrive from page DOM, which is untrusted input.
            return fail('BAD_REQUEST', 'token is not a valid address');
          }
          const owner = session.address;
          let amount: bigint;
          if (request.amount === undefined) {
            // Sell-the-whole-balance probe. Needs the account, so it is the one
            // quote that requires an unlocked wallet.
            if (request.side !== 'sell') return fail('BAD_REQUEST', 'amount is required for a buy');
            if (!owner) return fail('LOCKED', 'unlock to check whether this can be sold');
            try {
              amount = await trade.client.readContract({
                address: token,
                abi: ERC20_BALANCE_ABI,
                functionName: 'balanceOf',
                args: [owner],
              });
            } catch {
              return fail('BAD_REQUEST', 'could not read the token balance');
            }
            if (amount <= 0n) return fail('NO_BALANCE', 'you hold none of this token');
          } else {
            try {
              amount = BigInt(request.amount);
            } catch {
              return fail('BAD_REQUEST', 'amount is not an integer');
            }
            if (amount <= 0n) return fail('BAD_REQUEST', 'amount must be greater than zero');
          }
          if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps >= 10_000) {
            return fail('BAD_REQUEST', 'slippageBps out of range');
          }

          const ref = { address: token, chainId: trade.chainId };
          try {
            // Seen it, so it can appear in positions later.
            await trade.watchlist.add(token).catch(() => {});

            if (request.type === 'trade.quote') {
              // Quoting needs no account — only approvals do, and a quote does
              // not build them. A reverting quote is precisely the signal that
              // a sell is unavailable, so this path must surface the failure
              // rather than hide it behind a lock check (D-049).
              //
              // Deliberately no calldata: a quote is for display, and handing a
              // page ready-to-sign bytes serves no purpose it should have.
              const resolution = await trade.venues.resolve(ref);
              if (!resolution) return fail('UNSUPPORTED_VENUE', 'no venue trades this token');
              const quote =
                request.side === 'buy'
                  ? await resolution.adapter.quoteBuy(ref, amount)
                  : await resolution.adapter.quoteSell(ref, amount);
              return {
                ok: true,
                data: {
                  venueId: quote.venueId,
                  state: quote.state,
                  amountIn: quote.amountIn.toString(),
                  amountOut: quote.amountOut.toString(),
                  quoteAsset: quote.quoteAsset,
                  feeBps: quote.feeBps,
                },
              };
            }

            // Executing does need the account, for allowances.
            if (!owner) return fail('LOCKED', 'unlock to trade');
            const plan =
              request.side === 'buy'
                ? await planBuy(trade.venues, ref, amount, request.slippageBps)
                : await planSell(trade.venues, ref, amount, request.slippageBps, owner);

            const outcome = await trade.engine.execute(plan);
            return { ok: true, data: outcome };
          } catch (e) {
            if (e instanceof UnsupportedVenueError) return fail('UNSUPPORTED_VENUE', e.message);
            if (e instanceof Error && e.name === 'TradeRefused') {
              return fail((e as Error & { code: string }).code, e.message);
            }
            return toError(e);
          }
        }

        default:
          return fail('BAD_REQUEST', 'unknown message type');
      }
    } catch (e) {
      return toError(e);
    }
  };
}
