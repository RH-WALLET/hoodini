/**
 * Popup — the only surface that may create, unlock, or export a wallet.
 *
 * It holds no key and does no crypto. Every operation is a message to the
 * service worker, which owns the keystore; this file is a form and a state
 * machine, deliberately.
 */

import { useCallback, useEffect, useState } from 'react';
import { parseEther } from 'viem';
import type { Address, Hex } from 'viem';
import {
  wallet,
  positions as positionsApi,
  settings as settingsApi,
  trades,
  withdrawApi,
  type PendingTradeRow,
  type WithdrawOutcome,
  type PositionsResult,
} from './client.js';
import { DEFAULT_SETTINGS, MAX_PRESETS, MIN_PRESETS } from '@hoodini/core';
import { LIVE_TRADING } from '../background/config.js';
import { CANARY_MAX_WEI } from '../background/engine.js';
import { confirmNotice } from './notice.js';

/**
 * Read once at module load, from the build constant. Not state, not a setting,
 * not something a message can change — which is the whole point of it being a
 * build constant (invariant 5).
 */
const notice = confirmNotice(LIVE_TRADING, CANARY_MAX_WEI);
import type { WalletStatus } from '../background/protocol.js';

type View = 'loading' | 'setup' | 'locked' | 'unlocked';

const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await wallet.status());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reach the extension');
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The worker announces auto-locks; without this the popup would keep
    // showing "unlocked" after the timer had already dropped the key.
    const onMessage = (m: { type?: string }) => {
      if (m?.type === 'wallet.locked') void refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [refresh]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null);
      setBusy(true);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const view: View = !status ? 'loading' : !status.hasVault ? 'setup' : status.isUnlocked ? 'unlocked' : 'locked';

  return (
    <div className="wrap">
      <header>
        <h1>Hoodini</h1>
        <span className="tag">0% fee · non-custodial</span>
      </header>

      {error && <div className="error">{error}</div>}

      {/* Outside the view switch on purpose. A badge that leads to an empty
          popup is worse than no badge: if something is waiting, it is shown
          whatever state the wallet is in, and the sheet says so when approving
          needs an unlock first. */}
      <ConfirmSheet unlocked={view === 'unlocked'} />

      {view === 'loading' && <div className="panel muted">Loading…</div>}
      {view === 'setup' && <Setup busy={busy} run={run} />}
      {view === 'locked' && status && <Locked status={status} busy={busy} run={run} />}
      {view === 'unlocked' && status && <Unlocked status={status} busy={busy} run={run} />}

      <p className="note">
        Keys are generated on this device, encrypted with your password, and never leave it. Hoodini has no server.
      </p>
    </div>
  );
}

type RunFn = (fn: () => Promise<unknown>) => Promise<void>;

function formatEth(wei: string): string {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}

/**
 * The confirm sheet.
 *
 * A site proposed a trade; this is where a human decides. It is the only place
 * an approval can happen — a page can reach `trade.request` and nothing else
 * (D-054) — so everything shown here has to be true and legible:
 *
 * - the **origin** comes from the sender, so it cannot be forged by the page
 * - the **amount** is what will be spent, not what was displayed on the button
 * - the **quote** is fetched here, at approval time, rather than trusted from
 *   whenever the request was made
 *
 * Approving is the destructive action, so it is the one that has to be reached
 * for: Reject is the plain button and Approve carries the weight.
 */
function ConfirmSheet({ unlocked }: { unlocked: boolean }): React.JSX.Element | null {
  const [req, setReq] = useState<PendingTradeRow | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { request } = await trades.pending();
      setReq(request);
      setQuote(null);
      setQuoteError(null);
      if (!request) return;
      try {
        const q = await trades.quote(request.side, request.token, request.amount, request.slippageBps);
        setQuote(q.out ? `${formatEth(q.out)} ${q.quoteAsset ?? ''}`.trim() : null);
      } catch (e) {
        // A quote that will not price is a reason to hesitate, not to hide the
        // request — the user may still want to reject it.
        setQuoteError(e instanceof Error ? e.message : 'could not price this');
      }
    } catch {
      setReq(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const onMessage = (m: { type?: string }) => {
      if (m?.type === 'trade.pendingChanged') void load();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [load]);

  if (!req) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel stack" style={{ borderColor: '#7bf1a8' }}>
      <strong style={{ fontSize: 12 }}>Confirm trade</strong>

      <p className="note">
        <span className="mono">{req.origin}</span> asked to {req.side} this token.
      </p>

      <div className="stack" style={{ gap: 2 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>Token</span>
          <span className="mono">{short(req.token)}</span>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>{req.side === 'buy' ? 'Spend' : 'Sell'}</span>
          <span className="mono">{req.amount ? `${formatEth(req.amount)} ETH` : 'whole balance'}</span>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>You receive ≈</span>
          <span className="mono">{quote ?? (quoteError ? '—' : '…')}</span>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>Slippage</span>
          <span className="mono">{(req.slippageBps / 100).toFixed(2)}%</span>
        </div>
      </div>

      {quoteError && <p className="note warn">Could not price this: {quoteError}</p>}
      {error && <div className="error">{error}</div>}

      <p className={notice.tone === 'danger' ? 'note warn' : 'note'}>{notice.text}</p>

      <button className="ghost" disabled={busy} onClick={() => void act(() => trades.reject())}>
        Reject
      </button>
      <button disabled={busy || !unlocked} onClick={() => void act(() => trades.approve(req.id))}>
        {busy ? '…' : !unlocked ? 'Unlock to approve' : LIVE_TRADING ? 'Approve — spends real funds' : 'Approve'}
      </button>
    </div>
  );
}

/**
 * Withdraw.
 *
 * The way funds get back out. Until this existed you could put ETH into this
 * wallet and only retrieve it by exporting the private key into another one,
 * which is a trap rather than a design.
 *
 * Two-step on purpose: the address is typed, then shown back checksummed
 * alongside the exact amount, and only the second press sends. A wrong address
 * is the failure this cannot recover from, and it is the one no validation
 * catches — `0xabc…` is a perfectly valid address that simply is not yours.
 */
function Withdraw({ from }: { from: Address | null }): React.JSX.Element {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<WithdrawOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sweep = amount.trim().toLowerCase() === 'max';
  const wei = (() => {
    if (sweep) return 'max';
    const t = amount.trim();
    if (!/^\d*\.?\d+$/.test(t)) return null;
    try {
      return parseEther(t).toString();
    } catch {
      return null;
    }
  })();

  const reset = () => {
    setConfirming(false);
    setError(null);
  };

  const submit = async () => {
    if (!wei) {
      setError('amount must be a number of ETH, or "max"');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      setResult(await withdrawApi.send(to.trim(), wei));
      setTo('');
      setAmount('');
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the withdrawal failed');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel stack">
      <strong style={{ fontSize: 12 }}>Withdraw</strong>

      <div>
        <label htmlFor="wto">Send to</label>
        <input
          id="wto"
          className="mono"
          placeholder="0x…"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            reset();
          }}
        />
      </div>

      <div>
        <label htmlFor="wamt">Amount in ETH, or “max”</label>
        <input
          id="wamt"
          className="mono"
          inputMode="decimal"
          placeholder="0.01"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            reset();
          }}
        />
      </div>

      {error && <div className="error">{error}</div>}

      {result && (
        <p className="note">
          {result.status === 'sent' ? 'Sent' : 'Simulated'} {formatEth(result.valueWei)} ETH to{' '}
          <span className="mono">{short(result.to)}</span>
          {result.hash ? <> · <span className="mono">{result.hash.slice(0, 10)}…</span></> : null}
        </p>
      )}

      {!confirming ? (
        <button
          className="ghost"
          disabled={busy || !to.trim() || !amount.trim() || !from}
          onClick={() => {
            setResult(null);
            setConfirming(true);
          }}
        >
          Review
        </button>
      ) : (
        <>
          <p className="note warn">
            Sending {sweep ? 'the entire balance, less the network fee,' : `${amount.trim()} ETH`} to{' '}
            <span className="mono">{to.trim()}</span>. Check the address character by character — a transfer to the
            wrong one cannot be reversed by anybody.
          </p>
          {!LIVE_TRADING && <p className="note">This build cannot broadcast; this will simulate.</p>}
          <button className="ghost" disabled={busy} onClick={reset}>
            Back
          </button>
          <button className="danger" disabled={busy} onClick={() => void submit()}>
            {busy ? '…' : LIVE_TRADING ? 'Send for real' : 'Simulate'}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Trade settings.
 *
 * Edited as text and validated by the worker, not here. The popup could check
 * the same rules — but then there would be two copies of what counts as a valid
 * spend amount, and the one that matters is the one nearest the money. So this
 * shows what the worker says and gets out of the way.
 */
function TradeSettings(): React.JSX.Element {
  const [presets, setPresets] = useState<string[]>([...DEFAULT_SETTINGS.buyPresets]);
  const [slippage, setSlippage] = useState(String(DEFAULT_SETTINGS.slippageBps));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const s = await settingsApi.get();
        setPresets([...s.buyPresets]);
        setSlippage(String(s.slippageBps));
      } catch {
        // Defaults are already on screen; a failed read should not blank them.
      }
    })();
  }, []);

  const save = async (next: string[], bps: string) => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const applied = await settingsApi.set({
        buyPresets: next.map((p) => p.trim()).filter((p) => p !== ''),
        // NaN rather than 0 on a non-numeric input: 0 is a number the
        // validator would have to special-case, NaN is plainly not a value.
        slippageBps: /^\d+$/.test(bps.trim()) ? Number(bps.trim()) : Number.NaN,
      });
      setPresets([...applied.buyPresets]);
      setSlippage(String(applied.slippageBps));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not save');
    } finally {
      setBusy(false);
    }
  };

  const setPreset = (i: number, v: string) => {
    setSaved(false);
    setPresets((p) => p.map((x, j) => (j === i ? v : x)));
  };

  return (
    <div className="panel stack">
      <strong style={{ fontSize: 12 }}>Trade settings</strong>

      <label htmlFor="preset0">Quick-buy amounts (ETH)</label>
      <div className="row" style={{ gap: 6 }}>
        {presets.map((p, i) => (
          <input
            key={i}
            id={i === 0 ? 'preset0' : undefined}
            className="mono"
            inputMode="decimal"
            value={p}
            style={{ minWidth: 0 }}
            onChange={(e) => setPreset(i, e.target.value)}
          />
        ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button
          className="ghost"
          style={{ width: 'auto', padding: '2px 8px' }}
          disabled={presets.length >= MAX_PRESETS || busy}
          onClick={() => {
            setSaved(false);
            setPresets((p) => [...p, '']);
          }}
        >
          Add
        </button>
        <button
          className="ghost"
          style={{ width: 'auto', padding: '2px 8px' }}
          disabled={presets.length <= MIN_PRESETS || busy}
          onClick={() => {
            setSaved(false);
            setPresets((p) => p.slice(0, -1));
          }}
        >
          Remove
        </button>
      </div>

      <div>
        <label htmlFor="slip">Slippage (basis points — 100 = 1%)</label>
        <input
          id="slip"
          className="mono"
          inputMode="numeric"
          value={slippage}
          onChange={(e) => {
            setSaved(false);
            setSlippage(e.target.value);
          }}
        />
      </div>

      {error && <div className="error">{error}</div>}
      {saved && <p className="note">Saved. Open terminals update without a reload.</p>}

      <button disabled={busy} onClick={() => void save(presets, slippage)}>
        {busy ? '…' : 'Save'}
      </button>
      <p className="note">
        These size a quote, not a trade. Sending stays disabled in this build, and a sell is always the whole balance.
      </p>
    </div>
  );
}

/**
 * Holdings, computed locally from tokens this extension has seen.
 *
 * Explicitly not a portfolio: with no indexer (invariant 4) a token bought
 * elsewhere cannot appear, and the panel says so rather than showing a total
 * that looks authoritative and is quietly incomplete.
 */
function Positions(): React.JSX.Element {
  const [data, setData] = useState<PositionsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await positionsApi.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not load positions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 12 }}>Positions</strong>
        <button className="ghost" style={{ width: 'auto', padding: '2px 8px' }} onClick={() => void load()} disabled={loading}>
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {!error && data && data.positions.length === 0 && (
        <p className="note">Nothing yet. Tokens appear here once you quote or trade them.</p>
      )}

      {data?.positions.map((p) => (
        <div key={p.token} className="stack" style={{ gap: 2 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>{p.symbol ?? 'token'}</span>
            <span className="mono">{p.balanceFormatted}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="note">{p.venueId ?? 'no venue'}</span>
            <span className="note">
              {p.valueWei !== null ? `${formatEth(p.valueWei)} ETH` : (p.valueUnavailableReason ?? 'no quote')}
            </span>
          </div>
        </div>
      ))}

      {data && data.positions.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong style={{ fontSize: 12 }}>Total</strong>
            <strong style={{ fontSize: 12 }}>{formatEth(data.totalWei)} ETH</strong>
          </div>
          {/* Stated, not hidden: a total that quietly omitted unsellable rows
              would read as complete. */}
          {data.unvalued > 0 && (
            <p className="note">
              {data.unvalued} of {data.positions.length} could not be priced and are excluded from this total.
            </p>
          )}
        </>
      )}
      <p className="note">Only tokens seen in Hoodini. Not a full portfolio — there is no indexer.</p>
    </div>
  );
}

function Setup({ busy, run }: { busy: boolean; run: RunFn }): React.JSX.Element {
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < 8;
  const ready = password.length >= 8 && password === confirm && (mode === 'create' || /^0x[0-9a-fA-F]{64}$/.test(privateKey));

  return (
    <div className="panel stack">
      <div className="row">
        <button className={mode === 'create' ? 'primary' : 'ghost'} onClick={() => setMode('create')}>
          Create
        </button>
        <button className={mode === 'import' ? 'primary' : 'ghost'} onClick={() => setMode('import')}>
          Import
        </button>
      </div>

      {mode === 'import' && (
        <div>
          <label htmlFor="pk">Private key</label>
          <input
            id="pk"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="0x…"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value.trim())}
          />
        </div>
      )}

      <div>
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div>
        <label htmlFor="pw2">Confirm password</label>
        <input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>

      {tooShort && <div className="error">Use at least 8 characters.</div>}
      {mismatch && <div className="error">Passwords do not match.</div>}

      <button
        className="primary"
        disabled={!ready || busy}
        onClick={() =>
          run(() => (mode === 'create' ? wallet.create(password) : wallet.import(password, privateKey as Hex)))
        }
      >
        {mode === 'create' ? 'Create wallet' : 'Import wallet'}
      </button>

      <p className="note">
        There is no recovery. If you forget this password the wallet cannot be opened by us or by anyone — that is what
        non-custodial means.
      </p>
    </div>
  );
}

function Locked({ status, busy, run }: { status: WalletStatus; busy: boolean; run: RunFn }): React.JSX.Element {
  const [password, setPassword] = useState('');
  return (
    <div className="panel stack">
      <div>
        <span className="muted">Locked · </span>
        <span className="mono">{status.address ? short(status.address) : ''}</span>
      </div>
      <div>
        <label htmlFor="unlock">Password</label>
        <input
          id="unlock"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && password) void run(() => wallet.unlock(password));
          }}
        />
      </div>
      <button className="primary" disabled={!password || busy} onClick={() => run(() => wallet.unlock(password))}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      <p className="note">Unlocking takes a moment — the password is deliberately slow to derive.</p>
    </div>
  );
}

function Unlocked({ status, busy, run }: { status: WalletStatus; busy: boolean; run: RunFn }): React.JSX.Element {
  const [showExport, setShowExport] = useState(false);
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState<Hex | null>(null);

  const minutes = Math.round(status.autoLockMs / 60000);

  return (
    <div className="stack">
      <div className="panel stack">
        <div>
          <span className="muted">Unlocked · </span>
          <span className="mono">{status.address ? short(status.address) : ''}</span>
        </div>
        <div className="mono muted">{status.address}</div>
        <button onClick={() => run(() => wallet.lock())} disabled={busy}>
          Lock now
        </button>
        <p className="note">Locks automatically after {minutes} minutes idle, and whenever the browser suspends it.</p>
      </div>

      <Positions />
      <Withdraw from={status.address} />
      <TradeSettings />

      <div className="panel stack">
        {!showExport ? (
          <button className="ghost danger" onClick={() => setShowExport(true)}>
            Export private key
          </button>
        ) : (
          <>
            <p className="note warn">
              Anyone with this key owns the wallet. Never paste it into a site, a chat, or a support ticket.
            </p>
            {/* Password is required again even though the wallet is unlocked:
                revealing a key is the one action an idle session must not authorise. */}
            <div>
              <label htmlFor="exp">Confirm your password</label>
              <input id="exp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button
              className="danger"
              disabled={!password || busy}
              onClick={() =>
                run(async () => {
                  const { privateKey } = await wallet.exportKey(password);
                  setRevealed(privateKey);
                  setPassword('');
                })
              }
            >
              Reveal
            </button>
            {revealed && (
              <>
                <div className="mono warn panel">{revealed}</div>
                <button
                  className="ghost"
                  onClick={() => {
                    setRevealed(null);
                    setShowExport(false);
                  }}
                >
                  Hide
                </button>
              </>
            )}
            <button className="ghost" onClick={() => { setShowExport(false); setRevealed(null); setPassword(''); }}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
