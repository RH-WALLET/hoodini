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
  DEFAULT_SETTINGS,
  validateSettings,
  WithdrawalRefused,
} from '@hoodini/core';
import { loadPositions, planBuy, planSell, summarise, UnsupportedVenueError, type KdfParams, type VenueRouter } from '@hoodini/core';

/** Just the one read needed to size a sell-the-whole-balance probe. */
const ERC20_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
import { encodeFunctionData, getAddress, type Address } from 'viem';
import type { VaultStore } from './storage.js';
import type { TradeEngine } from './engine.js';
import { isAllowed, type Request, type Response, type Surface, type WalletStatus } from './protocol.js';
import type { Settings } from '@hoodini/core';
import type { PendingTrades, TradeRequest } from './pending.js';
import { WithdrawRefused, type Withdrawer } from './withdrawer.js';
import type { StandingConsent } from './consent.js';
import { fetchStats, fetchHistory } from './explorer.js';
import { PERMIT2, UNIVERSAL_ROUTER, SWAP_ROUTER_02 } from '@hoodini/core';

/**
 * The contracts this extension ever asks a user to approve.
 *
 * A general allowance scanner would need an indexer. This is the honest
 * alternative: the spenders Hoodini itself can cause an approval to, checked
 * against the tokens it knows the user has touched. It will not surface an
 * allowance granted in some other app, and the UI says so rather than implying
 * the list is exhaustive.
 */
const KNOWN_SPENDERS: readonly { readonly address: Address; readonly label: string }[] = [
  { address: PERMIT2, label: 'Permit2' },
  { address: UNIVERSAL_ROUTER, label: 'Uniswap UniversalRouter' },
  { address: SWAP_ROUTER_02, label: 'Uniswap SwapRouter02' },
];

const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

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
  /** Absent in tests that do not exercise settings; their messages then use defaults. */
  readonly settings?: { read(): Promise<Settings>; write(s: unknown): Promise<Settings> };
  /** Holds the one trade awaiting the user's confirmation (D-026). */
  readonly pending?: PendingTrades;
  /** Moves plain ETH out. Absent in tests that do not exercise it. */
  readonly withdrawer?: Withdrawer;
  /**
   * Standing consent. Absent in tests and builds that do not use it, in which
   * case every proposal keeps its confirmation sheet — the pre-D-059 behaviour.
   */
  readonly consent?: StandingConsent;
  /**
   * Told whenever the pending request appears or clears, so the worker can
   * badge the toolbar icon. Injected rather than called directly because the
   * router is tested without a browser, and because a message handler reaching
   * for `chrome.action` is a handler that cannot be run offline.
   */
  readonly onPendingChange?: (request: TradeRequest | null) => void;
  /**
   * Told whenever standing consent is armed or disarmed.
   *
   * Armed means money can move without anything appearing on screen, so the
   * state has to be visible somewhere the user does not have to go looking:
   * an invisible armed switch is the failure mode this whole feature invites.
   */
  readonly onConsentChange?: (armed: boolean) => void;
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
  const { store, session, kdf, trade, settings, pending, withdrawer, consent, onPendingChange, onConsentChange } =
    deps;
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

  return async function handle(
    request: Request,
    surface: Surface | null,
    /** The sender's origin, for showing in a confirmation. Never from the message. */
    origin?: string | null,
  ): Promise<Response> {
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
          // Auto-approval rides on the session rather than on a separate switch
          // (D-063): the password is the authorisation, and it lasts exactly as
          // long as the unlock does. Nothing is armed if the user turned it off,
          // and that choice persists across restarts.
          if (consent && (await consent.armOnUnlock())) onConsentChange?.(true);
          return { ok: true, data: { address } };
        }

        case 'wallet.lock':
          session.lock();
          // Locking is the user stepping away, which is exactly when a standing
          // approval should stop standing. Disarmed here rather than left for
          // `permits()` to refuse, so the popup shows the truth instead of an
          // armed switch that quietly does nothing.
          consent?.disarm();
          onConsentChange?.(false);
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

        case 'settings.get': {
          if (!settings) return { ok: true, data: DEFAULT_SETTINGS };
          return { ok: true, data: await settings.read() };
        }

        case 'settings.set': {
          if (!settings) return fail('UNAVAILABLE', 'settings are not wired up in this build');
          // Validated before writing, so a bad edit is reported rather than
          // silently replaced with a default — someone who typed `0,5` needs
          // telling, not overruling.
          const invalid = validateSettings(request.settings);
          if (invalid) return fail('BAD_REQUEST', invalid.message);
          return { ok: true, data: await settings.write(request.settings) };
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

        case 'wallet.withdraw': {
          if (!withdrawer) return fail('UNAVAILABLE', 'withdrawals are not wired up in this build');
          if (!session.address) return fail('LOCKED', 'unlock to withdraw');
          try {
            const outcome = await withdrawer.withdraw({ to: request.to, amount: request.amount });
            return { ok: true, data: outcome };
          } catch (e) {
            // Refusals carry a code and a message naming the field to fix;
            // anything else stays generic, since it may quote an input.
            if (e instanceof WithdrawalRefused || e instanceof WithdrawRefused) {
              return fail(e.code, e.message);
            }
            throw e;
          }
        }

        case 'trade.request': {
          if (!pending) return fail('UNAVAILABLE', 'trade requests are not wired up in this build');
          let token: Address;
          try {
            token = getAddress(request.token);
          } catch {
            return fail('BAD_REQUEST', 'token is not a valid address');
          }
          if (request.side === 'buy' && request.amount === undefined) {
            return fail('BAD_REQUEST', 'amount is required for a buy');
          }
          if (request.amount !== undefined && !/^\d+$/.test(request.amount)) {
            // Wei as a decimal string. Anything else is a page trying its luck.
            return fail('BAD_REQUEST', 'amount must be a whole number of wei');
          }
          const proposed = pending.propose({
            side: request.side,
            token,
            ...(request.amount !== undefined ? { amount: request.amount } : {}),
            slippageBps: request.slippageBps,
            // From the sender, never the message.
            origin: origin ?? 'unknown',
          });
          if (!proposed) {
            return fail('PENDING_EXISTS', 'another trade is already awaiting confirmation');
          }

          // Standing consent (D-059). The proposal is recorded first and then
          // immediately consumed, rather than shortcutting past `pending`: the
          // one-at-a-time rule, the origin capture and the single-use take()
          // are exactly the properties that should not be bypassed just
          // because nobody is going to read the sheet.
          if (consent && (await consent.permits(proposed, session.address !== null))) {
            const taken = pending.take(proposed.id);
            if (taken) {
              onPendingChange?.(null);
              const outcome = await handle(
                {
                  type: 'trade.execute',
                  side: taken.side,
                  token: taken.token,
                  amount: taken.amount ?? '0',
                  slippageBps: taken.slippageBps,
                },
                'popup',
              );
              // Reported as an auto-approval so the page's button can say so,
              // and so this is never mistaken for a queued confirmation.
              //
              // The outcome itself is deliberately NOT handed back. A `sent`
              // result carries transaction receipts, and a receipt carries
              // `from` — the user's address. `positions.list` is popup-only
              // precisely so a site cannot learn that (D-053), and auto-approval
              // must not become the hole that leaks it. The page proposed the
              // trade; it does not get to read the wallet off the answer.
              return outcome.ok
                ? { ok: true, data: { id: proposed.id, autoApproved: true } }
                : { ok: false, error: outcome.error };
            }
          }

          onPendingChange?.(proposed);
          return { ok: true, data: { id: proposed.id } };
        }

        case 'wallet.balance': {
          if (!trade) return fail('UNAVAILABLE', 'chain access is not wired up in this build');
          const owner = session.address;
          if (!owner) return fail('LOCKED', 'unlock to see your balance');
          try {
            const wei = await trade.client.getBalance({ address: owner });
            return { ok: true, data: { wei: wei.toString() } };
          } catch {
            return fail('UNAVAILABLE', 'could not reach the network');
          }
        }

        case 'chain.stats':
          return { ok: true, data: await fetchStats() };

        case 'history.list': {
          const owner = session.address;
          if (!owner) return fail('LOCKED', 'unlock to see your transactions');
          const rows = await fetchHistory(owner);
          if (rows === null) return fail('UNAVAILABLE', 'the block explorer did not answer');
          return { ok: true, data: { rows } };
        }

        case 'approvals.list': {
          if (!trade) return fail('UNAVAILABLE', 'chain access is not wired up in this build');
          const owner = session.address;
          if (!owner) return fail('LOCKED', 'unlock to see your approvals');

          const tokens = await trade.watchlist.list();
          // Every token against every known spender, all at once. Serially this
          // would be tokens x spenders round trips and the screen would crawl.
          const checks = tokens.flatMap((token) =>
            KNOWN_SPENDERS.map(async (spender) => {
              try {
                const amount = await trade.client.readContract({
                  address: token, abi: ERC20_ALLOWANCE_ABI, functionName: 'allowance',
                  args: [owner, spender.address],
                });
                if (amount <= 0n) return null;
                const symbol = await trade.client
                  .readContract({ address: token, abi: ERC20_ALLOWANCE_ABI, functionName: 'symbol' })
                  .catch(() => null);
                return {
                  token, symbol, spender: spender.address, spenderLabel: spender.label,
                  amount: amount.toString(),
                  // 2^256-1 is the "forever, any amount" approval, and it is
                  // worth naming as such rather than printing 78 digits.
                  unlimited: amount > 2n ** 255n,
                };
              } catch {
                // Not a readable ERC-20 at that address; nothing to revoke.
                return null;
              }
            }),
          );
          const rows = (await Promise.all(checks)).filter((r) => r !== null);
          return { ok: true, data: { rows, scanned: tokens.length } };
        }

        case 'approvals.revoke': {
          if (!trade) return fail('UNAVAILABLE', 'trading is not wired up in this build');
          const owner = session.address;
          if (!owner) return fail('LOCKED', 'unlock to revoke');
          let token: Address, spender: Address;
          try {
            token = getAddress(request.token);
            spender = getAddress(request.spender);
          } catch {
            return fail('BAD_REQUEST', 'not a valid address');
          }
          // Re-dispatched through the engine rather than signed here, so the
          // LIVE_TRADING gate, the journal and the value ceiling all apply
          // exactly as they do to a trade. Setting an allowance to zero sends
          // no ETH, so the ceiling is never the thing that refuses it.
          const data = encodeFunctionData({
            abi: ERC20_ALLOWANCE_ABI, functionName: 'approve', args: [spender, 0n],
          });
          try {
            const outcome = await trade.engine.execute({
              side: 'sell',
              token: { address: token, chainId: trade.chainId },
              venueId: 'revoke',
              via: 'registry',
              state: 'open',
              quote: {
                venueId: 'revoke', state: 'open', amountIn: 0n, amountOut: 0n,
                quoteAsset: null, feeBps: 0, priceImpactBps: null,
              },
              minOut: 0n,
              steps: [{ kind: 'approve', tx: { to: token, data, value: 0n, description: 'revoke allowance' } }],
              mayNeedMoreApprovals: false,
            } as never);
            return { ok: true, data: outcome };
          } catch (e) {
            if (e instanceof Error && e.name === 'TradeRefused') {
              return fail((e as Error & { code: string }).code, e.message);
            }
            return toError(e);
          }
        }

        case 'consent.arm': {
          if (!consent) return fail('UNAVAILABLE', 'standing consent is not wired up in this build');
          // Arming while locked would be a switch that silently does nothing
          // until the next unlock, which is the worst kind of security control.
          if (!session.address) return fail('LOCKED', 'unlock before arming auto-approve');
          await consent.setAutoArm(true);
          consent.arm();
          onConsentChange?.(true);
          return { ok: true, data: await consent.state() };
        }

        case 'consent.disarm': {
          if (!consent) return fail('UNAVAILABLE', 'standing consent is not wired up in this build');
          // Never refused, for any reason. A user reaching for the off switch
          // must always find it working, including while locked. Turning it off
          // sticks: otherwise the next unlock would quietly turn it back on.
          await consent.setAutoArm(false);
          consent.disarm();
          onConsentChange?.(false);
          return { ok: true, data: await consent.state() };
        }

        case 'consent.status': {
          if (!consent) return { ok: true, data: { armed: false, armedAt: null, liveUnlocked: false, autoArm: false } };
          const state = await consent.state();
          // Auto-lock expires a session without any message reaching this
          // router, so the stored flag alone could outlive the unlock it
          // depends on. Composed here, the answer can never claim armed while
          // nothing is able to sign.
          return { ok: true, data: { ...state, armed: state.armed && session.address !== null } };
        }

        case 'trade.pending': {
          if (!pending) return fail('UNAVAILABLE', 'trade requests are not wired up in this build');
          return { ok: true, data: { request: pending.peek() } };
        }

        case 'trade.reject': {
          if (!pending) return fail('UNAVAILABLE', 'trade requests are not wired up in this build');
          pending.clear();
          onPendingChange?.(null);
          return { ok: true, data: {} };
        }

        case 'trade.approve': {
          if (!pending || !trade) return fail('UNAVAILABLE', 'trading is not wired up in this build');
          // Checked without consuming first. An earlier version took the
          // request before testing whether the wallet was unlocked, so clicking
          // Approve while locked destroyed the very thing the user was about to
          // approve — they unlocked to find nothing there. Reasons the user can
          // fix must not cost them the request.
          const waiting = pending.peek();
          if (!waiting || waiting.id !== request.id) {
            return fail('NOT_FOUND', 'that request is no longer waiting — it may have expired');
          }
          if (!session.address) return fail('LOCKED', 'unlock to trade');

          // Now consume, before anything runs, so a double click cannot spend
          // twice. If the trade then fails the user proposes again, which is a
          // far better outcome than a second send.
          const approved = pending.take(request.id);
          onPendingChange?.(null);
          if (!approved) return fail('NOT_FOUND', 'that request was answered a moment ago');
          // Re-dispatched through the same path a popup-initiated trade takes,
          // so approval adds a confirmation and changes nothing else about how
          // a trade is planned, gated or sent.
          // Amount is omitted on a sell, never coerced to '0'. `trade.execute`
          // reads "sell the whole balance" from the *absence* of an amount and
          // rejects an explicit zero as out of range, so the previous
          // `?? '0'` turned every approved sell into BAD_REQUEST (D-061).
          const execute: Request =
            approved.amount !== undefined
              ? {
                  type: 'trade.execute',
                  side: approved.side,
                  token: approved.token,
                  amount: approved.amount,
                  slippageBps: approved.slippageBps,
                }
              : {
                  type: 'trade.execute',
                  side: approved.side,
                  token: approved.token,
                  slippageBps: approved.slippageBps,
                };
          return handle(execute, 'popup');
        }

        case 'trade.warm': {
          // Answers `{ ok: true }` no matter what happens below, including when
          // trading is not wired up at all. Warming is an optimisation, and an
          // optimisation that reports its own failures teaches a page to read
          // them: a differing reply would say whether a venue trades this token
          // before the user has asked anything.
          if (trade) {
            let token: Address | null = null;
            try {
              token = getAddress(request.token);
            } catch {
              // Untrusted page DOM. Nothing to warm and nothing to report.
            }
            if (token) {
              // Not awaited. The point is to spend the pointer's travel time,
              // and a hover must never make the page wait on RPC.
              void trade.venues.resolve({ address: token, chainId: trade.chainId }).catch(() => {});
            }
          }
          return { ok: true, data: null };
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
            // The canary has now happened by hand, so standing consent may
            // approve live sends from here on (invariant 5, D-059). Recorded
            // only on a real broadcast: a simulated run proves nothing about
            // whether a human ever watched money leave.
            if (outcome.status === 'sent') await consent?.recordLiveSend().catch(() => {});
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
