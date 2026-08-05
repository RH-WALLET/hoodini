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
  consentApi,
  balanceApi,
  chainApi,
  historyApi,
  approvalsApi,
  type ChainStats,
  type HistoryRow,
  type ApprovalRow,
  type ConsentState,
  type PendingTradeRow,
  type WithdrawOutcome,
  type PositionsResult,
} from './client.js';
import { DEFAULT_SETTINGS, MAX_PRESETS, MIN_PRESETS, type Settings } from '@hoodini/core';
import { TopHat, Icon } from './icons.js';
import { SUPPORTED_HOSTS } from '../hosts.js';
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

  const [tab, setTab] = useState<'home' | 'activity' | 'settings'>('home');
  const view: View = !status ? 'loading' : !status.hasVault ? 'setup' : status.isUnlocked ? 'unlocked' : 'locked';

  return (
    <div className="app">
      {/* Outside the view switch on purpose. A badge that leads to an empty
          popup is worse than no badge: if something is waiting, it is shown
          whatever state the wallet is in, and the sheet says so when approving
          needs an unlock first. */}
      <ConfirmSheet unlocked={view === 'unlocked'} />

      {view === 'unlocked' && status && <AccountBar status={status} busy={busy} run={run} />}
      {error && <div className="error">{error}</div>}

      {view === 'loading' && (
        <div className="solo">
          <p className="note" style={{ textAlign: 'center' }}>Loading…</p>
        </div>
      )}
      {view === 'setup' && <Setup busy={busy} run={run} />}
      {view === 'locked' && status && <Locked status={status} busy={busy} run={run} />}

      {view === 'unlocked' && status && (
        <>
          <div className="scroll">
            {tab === 'home' && <Home status={status} busy={busy} run={run} />}
            {tab === 'activity' && <ActivityTab />}
            {tab === 'settings' && <SettingsTab status={status} busy={busy} run={run} />}
          </div>
          <nav className="nav">
            <button aria-current={tab === 'home' ? 'page' : undefined} onClick={() => setTab('home')}>
              <Icon.home /> Home
            </button>
            <button aria-current={tab === 'activity' ? 'page' : undefined} onClick={() => setTab('activity')}>
              <Icon.activity /> Activity
            </button>
            <button aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}>
              <Icon.settings /> Settings
            </button>
          </nav>
        </>
      )}
    </div>
  );
}

/**
 * The account bar.
 *
 * Address is a button rather than text: copying it is the single most common
 * thing anyone does on a wallet's home screen, and making that a click on the
 * thing itself removes the only step between wanting it and having it.
 */
function AccountBar({ status, busy, run }: { status: WalletStatus; busy: boolean; run: RunFn }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const load = () => void consentApi.status().then((c) => setArmed(c.armed)).catch(() => setArmed(false));
    load();
    const onMsg = (m: { type?: string }) => { if (m?.type === 'consent.changed') load(); };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const copy = async () => {
    if (!status.address) return;
    await navigator.clipboard.writeText(status.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="acct">
      <div className="avatar"><TopHat size={22} /></div>
      <div className="acct-id">
        <div className="acct-name">Hoodini</div>
        <button className="acct-addr" onClick={() => void copy()} title="Copy address">
          {status.address ? short(status.address) : ''} {copied ? <Icon.check /> : <Icon.copy />}
        </button>
      </div>
      <div className="acct-actions">
        {armed && (
          <span className="icon-btn armed" title="Auto-approve is armed"><Icon.bolt /></span>
        )}
        <button className="icon-btn" title="Lock now" disabled={busy} onClick={() => run(() => wallet.lock())}>
          <Icon.lock />
        </button>
      </div>
    </div>
  );
}

/** Home: what you hold, and the four things you can do about it. */
function Home({ status, busy, run }: { status: WalletStatus; busy: boolean; run: RunFn }): React.JSX.Element {
  const [wei, setWei] = useState<string | null>(null);
  const [pos, setPos] = useState<PositionsResult | null>(null);
  const [open, setOpen] = useState<'receive' | 'withdraw' | null>(null);

  const [stats, setStats] = useState<ChainStats | null>(null);

  useEffect(() => {
    void balanceApi.read().then((b) => setWei(b.wei)).catch(() => setWei(null));
    void positionsApi.list().then(setPos).catch(() => setPos(null));
    // Carries no address, so this one is free to ask for on open (D-064).
    void chainApi.stats().then(setStats).catch(() => setStats(null));
  }, []);

  // Everything is denominated in ETH rather than a currency, because pricing it
  // in dollars would need a feed and there is no backend to ask (invariant 4).
  const liquid = wei ? BigInt(wei) : 0n;
  const inTokens = pos ? BigInt(pos.totalWei) : 0n;
  const total = liquid + inTokens;

  const openTerminal = () => void chrome.tabs.create({ url: 'https://axiom.trade/' });

  return (
    <>
      <div className="hero">
        <div className="amount">
          {wei === null ? '—' : fmt(total)}
          <span className="unit">ETH</span>
        </div>
        {/* Shown only when the explorer actually answered with a number. A
            dash is honest; a $0.00 derived from a failed fetch is not. */}
        {stats?.coinPriceUsd != null && (
          <div className="fiat">≈ ${usd(total, stats.coinPriceUsd)}</div>
        )}
        <div className="split">
          <b>{fmt(liquid)}</b> liquid · <b>{fmt(inTokens)}</b> in tokens
        </div>
        <div className="chip">0% fee, every trade</div>
      </div>

      <div className="tiles">
        <button className="tile" onClick={() => setOpen(open === 'receive' ? null : 'receive')}>
          <Icon.receive /> Receive
        </button>
        <button className="tile" onClick={() => setOpen(open === 'withdraw' ? null : 'withdraw')}>
          <Icon.send /> Send
        </button>
        <button className="tile" onClick={openTerminal}>
          <Icon.trade /> Trade
        </button>
        <button className="tile" disabled={busy} onClick={() => run(() => wallet.lock())}>
          <Icon.lock /> Lock
        </button>
      </div>

      {open === 'receive' && <Receive address={status.address} />}
      {open === 'withdraw' && <Withdraw from={status.address} />}

      <Positions />
      <ChainStrip stats={stats} />
      <SiteStatus />
    </>
  );
}

/** ETH price and gas, the two numbers a trader glances at constantly. */
function ChainStrip({ stats }: { stats: ChainStats | null }): React.JSX.Element {
  return (
    <div className="strip">
      <span>
        <b>ETH</b> {stats?.coinPriceUsd != null ? `$${stats.coinPriceUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}
      </span>
      <span className="gas">
        {stats?.gasGwei != null ? `${stats.gasGwei} Gwei` : '— Gwei'}
      </span>
    </div>
  );
}

/**
 * Whether the overlay is running on the tab you are looking at.
 *
 * Twice now, "no buttons" has cost a debugging session that a single line here
 * would have ended: the adapter refusing a non-Robinhood row and the extension
 * genuinely not injecting look identical from the outside. This says which.
 */
function SiteStatus(): React.JSX.Element {
  const [host, setHost] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    // Wrapped, not just `.catch`-ed. If `chrome.tabs.query` is missing the call
    // throws synchronously, and an uncaught throw inside an effect unmounts the
    // whole tree — the entire popup would go blank because a status line could
    // not be drawn. Nothing on this screen is worth that.
    try {
      const q = chrome.tabs?.query?.({ active: true, currentWindow: true });
      if (!q) return setHost(null);
      void q
        .then(([tab]) => {
          const url = tab?.url;
          setHost(url && /^https?:/.test(url) ? new URL(url).hostname : null);
        })
        .catch(() => setHost(null));
    } catch {
      setHost(null);
    }
  }, []);

  if (host === undefined) return <div className="site" />;
  const supported = host !== null && SUPPORTED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

  return (
    <div className="site">
      <span className={supported ? 'dot on' : 'dot off'} />
      <span className="site-host">{host ?? 'no page open'}</span>
      <span className="site-state">{supported ? 'Hoodini is active' : 'not a supported site'}</span>
    </div>
  );
}

/** Receive: the address, large enough to check character by character. */
function Receive({ address }: { address: Address | null }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card stack" style={{ marginBottom: 12 }}>
      <div className="card-title">Your address on Robinhood Chain</div>
      <div className="mono" style={{ lineHeight: 1.7 }}>{address}</div>
      <button
        className="primary"
        onClick={async () => {
          if (!address) return;
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? 'Copied' : 'Copy address'}
      </button>
      <p className="note">Only send Robinhood Chain assets here. Anything on another network is gone.</p>
    </div>
  );
}

/** Activity: what is happening right now, and what has been pre-authorised. */
function ActivityTab(): React.JSX.Element {
  const [pending, setPending] = useState<PendingTradeRow | null>(null);
  useEffect(() => {
    const load = () => void trades.pending().then((r) => setPending(r.request)).catch(() => setPending(null));
    load();
    const onMsg = (m: { type?: string }) => { if (m?.type === 'trade.pendingChanged') load(); };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  return (
    <div style={{ paddingTop: 14 }}>
      <AutoApprove />
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-title">Waiting on you</div>
        {pending ? (
          <p className="note">
            A {pending.side} from <b className="muted">{pending.origin}</b> is waiting. The confirmation is showing over
            this window.
          </p>
        ) : (
          <div className="empty">
            <div className="big">🎩</div>
            <p>Nothing up your sleeve. Trades you start on a terminal show up here.</p>
          </div>
        )}
      </div>

      <History />
      <Approvals />
    </div>
  );
}

/**
 * Sent transactions, fetched on demand.
 *
 * On demand rather than on open because the request necessarily names this
 * wallet to the block explorer. That is a genuine disclosure even though it
 * carries no key and sends nothing of ours, so it is a thing the user asks for
 * and is told about, not one that happens quietly every time the popup opens
 * (D-064).
 */
function History(): React.JSX.Element {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setRows((await historyApi.list()).rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reach the explorer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-title">Transactions</div>
      {rows === null ? (
        <>
          <p className="note" style={{ marginBottom: 10 }}>
            Loading these asks Blockscout about your address, so it will know which wallet you are. Nothing else is
            sent, and nothing is stored.
          </p>
          <button className="small" disabled={busy} onClick={() => void load()}>
            {busy ? 'Loading…' : 'Load from the explorer'}
          </button>
        </>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="big">🕳️</div>
          <p>This wallet has never sent anything.</p>
        </div>
      ) : (
        <>
          {rows.map((r) => (
            <a
              key={r.hash}
              className="tx"
              href={`https://robinhoodchain.blockscout.com/tx/${r.hash}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span className={r.success ? 'dot on' : 'dot off'} />
              <span className="tx-id">
                <span className="tx-m">{r.method ?? 'transfer'}</span>
                <span className="tx-to">{r.toName ?? (r.to ? short(r.to as Address) : '—')}</span>
              </span>
              <span className="tx-v">
                {BigInt(r.valueWei) > 0n ? `${fmt(BigInt(r.valueWei))} ETH` : '—'}
              </span>
            </a>
          ))}
          <p className="note" style={{ paddingTop: 8 }}>Sent transactions only. Tap one to open the explorer.</p>
        </>
      )}
      {error && <div className="error" style={{ margin: '10px 0 0' }}>{error}</div>}
    </div>
  );
}

/**
 * Allowances this wallet has granted, and a way to take them back.
 *
 * Not exhaustive, and it says so: without an indexer the only honest scan is
 * the spenders Hoodini itself can cause an approval to, against the tokens it
 * has seen. An allowance granted in another app will not appear here, and
 * implying otherwise would be worse than showing nothing.
 */
function Approvals(): React.JSX.Element {
  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await approvalsApi.list()).rows);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const revoke = async (r: ApprovalRow) => {
    setBusy(r.token + r.spender);
    setError(null);
    try {
      await approvalsApi.revoke(r.token, r.spender);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not revoke');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-title">Approvals</div>
      {rows === null ? (
        <p className="note">Checking…</p>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="big">🔒</div>
          <p>No outstanding allowances to the contracts Hoodini uses.</p>
        </div>
      ) : (
        rows.map((r) => (
          <div key={r.token + r.spender} className="appr">
            <div className="appr-id">
              <div className="appr-t">
                {r.symbol ?? short(r.token)} → {r.spenderLabel}
              </div>
              <div className={r.unlimited ? 'appr-a bad' : 'appr-a'}>
                {r.unlimited ? 'unlimited — can spend all of it' : 'limited amount'}
              </div>
            </div>
            <button
              className="danger small"
              style={{ width: 'auto' }}
              disabled={busy !== null}
              onClick={() => void revoke(r)}
            >
              {busy === r.token + r.spender ? '…' : 'Revoke'}
            </button>
          </div>
        ))
      )}
      {error && <div className="error" style={{ margin: '10px 0 0' }}>{error}</div>}
      <p className="note" style={{ paddingTop: 8 }}>
        Only the contracts Hoodini uses, against tokens it has seen. Allowances granted in other apps are not
        listed — there is no indexer to ask.
      </p>
    </div>
  );
}

/** Settings: presets and slippage, then the things that need a password. */
function SettingsTab({ status, busy, run }: { status: WalletStatus; busy: boolean; run: RunFn }): React.JSX.Element {
  const [showExport, setShowExport] = useState(false);
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState<Hex | null>(null);
  const minutes = Math.round(status.autoLockMs / 60000);

  return (
    <div style={{ paddingTop: 14 }}>
      <TradeSettings />

      <div className="card stack">
        <div className="card-title">Security</div>
        <p className="note">
          Locks automatically after {minutes} minutes idle, and whenever the browser suspends it. Keys are generated on
          this device, encrypted with your password, and never leave it. There is no server.
        </p>
        {!showExport ? (
          <button className="danger small" onClick={() => setShowExport(true)}>
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
                <div className="mono armed-banner">{revealed}</div>
                <button className="ghost" onClick={() => { setRevealed(null); setShowExport(false); }}>Hide</button>
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

/**
 * Wei priced in dollars.
 *
 * The division happens in floating point, which is fine here and would not be
 * anywhere else: this figure is a rough second opinion beside an exact ETH
 * amount, never the number anything is signed against.
 */
function usd(wei: bigint, price: number): string {
  const eth = Number(wei) / 1e18;
  return (eth * price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Six significant figures of ETH: enough to see a canary, short enough to read. */
function fmt(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${frac}`;
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
    // Covers the window rather than queueing below it. This is the only screen
    // in the extension that authorises a spend, so nothing else should be
    // competing for the same glance.
    <div className="sheet">
      <div className="sheet-inner">
        <p className="sheet-hd">{req.side === 'buy' ? 'Approve this buy?' : 'Approve this sell?'}</p>
        <p className="note" style={{ marginBottom: 12 }}>
          Requested by <b className="muted">{req.origin}</b>
        </p>

        <dl style={{ margin: 0 }}>
          <div className="kv"><dt>Token</dt><dd className="mono">{short(req.token)}</dd></div>
          <div className="kv">
            <dt>{req.side === 'buy' ? 'You spend' : 'You sell'}</dt>
            <dd className="mono">{req.amount ? `${formatEth(req.amount)} ETH` : 'whole balance'}</dd>
          </div>
          <div className="kv">
            <dt>You receive ≈</dt>
            <dd className="mono">{quote ?? (quoteError ? '—' : '…')}</dd>
          </div>
          <div className="kv"><dt>Max slippage</dt><dd className="mono">{(req.slippageBps / 100).toFixed(2)}%</dd></div>
          <div className="kv"><dt>Hoodini's cut</dt><dd style={{ color: 'var(--zero)' }}>0.00%</dd></div>
        </dl>

        {quoteError && <p className="note warn">Could not price this: {quoteError}</p>}
        {error && <div className="error" style={{ margin: '8px 0 0' }}>{error}</div>}

        <p className={notice.tone === 'danger' ? 'note warn' : 'note'} style={{ margin: '10px 0 14px' }}>
          {notice.text}
        </p>

        <div className="stack">
          <button
            className={LIVE_TRADING ? 'danger' : 'primary'}
            disabled={busy || !unlocked}
            onClick={() => void act(() => trades.approve(req.id))}
          >
            {busy ? '…' : !unlocked ? 'Unlock to approve' : LIVE_TRADING ? 'Approve — spends real funds' : 'Approve'}
          </button>
          <button className="ghost" disabled={busy} onClick={() => void act(() => trades.reject())}>
            Reject
          </button>
        </div>
      </div>
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
    <div className="card stack">
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
/**
 * Arming standing consent (D-059).
 *
 * The copy here is blunt on purpose. This is the one control in the extension
 * that lets funds move with nothing appearing on screen, and it is uncapped and
 * has no expiry by explicit instruction, so the surface that arms it should say
 * so rather than describe it as a convenience. Two presses to arm, one to
 * disarm: an off switch must never be harder to reach than the on switch.
 */
function AutoApprove(): React.JSX.Element {
  const [state, setState] = useState<ConsentState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setState(await consentApi.status());
    } catch {
      setState(null);
    }
  };
  useEffect(() => {
    void load();
    // The worker disarms on lock and on its own eviction, so the popup cannot
    // assume what it last rendered is still true.
    const onMsg = (m: { type?: string }) => {
      if (m?.type === 'consent.changed') void load();
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const act = async (fn: () => Promise<ConsentState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await fn());
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  if (state?.armed) {
    return (
      <div className="card stack">
        <div>
          <span className="warn">● Auto-approve is ARMED</span>
        </div>
        <p className="note warn">
          Buys from a supported site are being signed and sent without a confirmation. There is no amount limit
          and no expiry. Your password is what authorises it, so it turns itself back on every time you unlock,
          and it stops the moment the wallet locks.
        </p>
        <button className="danger" disabled={busy} onClick={() => void act(() => consentApi.disarm())}>
          Turn off — and keep it off
        </button>
        {error && <p className="note warn">{error}</p>}
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="muted">Auto-approve · off</div>
      {!confirming ? (
        <button className="ghost" onClick={() => setConfirming(true)}>
          Arm auto-approve
        </button>
      ) : (
        <>
          <p className="note warn">
            This approves buys without showing you anything, and switches itself on again at every unlock. The
            amount is chosen by the website, not by your presets, so a compromised site could propose far more
            than you would click. With no limit set, the ceiling on a single buy is your balance.
          </p>
          <p className="note">
            Sells always ask. A locked wallet still signs nothing, and it locks itself after 25 idle minutes.
            {state && !state.liveUnlocked
              ? ' Your first live trade must be approved by hand before this can send anything.'
              : ''}
          </p>
          <button className="danger" disabled={busy} onClick={() => void act(() => consentApi.arm())}>
            I understand — arm it
          </button>
          <button className="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      )}
      {error && <p className="note warn">{error}</p>}
    </div>
  );
}

/**
 * Fold the fields currently on screen back into a full settings record.
 *
 * The edited tab wins; the other two are carried through untouched. Slippage
 * becomes NaN rather than 0 on a non-numeric input — 0 is a number the
 * validator would have to special-case, NaN is plainly not a value.
 */
function withEdits(base: Settings, index: number, presets: string[], bps: string): Settings {
  const profiles = base.profiles.map((p, i) =>
    i === index
      ? {
          buyPresets: presets.map((v) => v.trim()).filter((v) => v !== ''),
          slippageBps: /^\d+$/.test(bps.trim()) ? Number(bps.trim()) : Number.NaN,
        }
      : p,
  );
  return { ...base, profiles, activeProfile: index };
}

function TradeSettings(): React.JSX.Element {
  const [all, setAll] = useState<Settings | null>(null);
  const [tab, setTab] = useState(0);
  const [presets, setPresets] = useState<string[]>([...DEFAULT_SETTINGS.buyPresets]);
  const [slippage, setSlippage] = useState(String(DEFAULT_SETTINGS.slippageBps));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const s = await settingsApi.get();
        setAll(s);
        setTab(s.activeProfile);
        setPresets([...(s.profiles[s.activeProfile]?.buyPresets ?? s.buyPresets)]);
        setSlippage(String(s.profiles[s.activeProfile]?.slippageBps ?? s.slippageBps));
      } catch {
        // Defaults are already on screen; a failed read should not blank them.
      }
    })();
  }, []);

  /** Move to another tab, keeping unsaved edits on the one being left. */
  const pick = (i: number) => {
    if (!all) return;
    const next = withEdits(all, tab, presets, slippage);
    setAll(next);
    setTab(i);
    setPresets([...(next.profiles[i]?.buyPresets ?? [])]);
    setSlippage(String(next.profiles[i]?.slippageBps ?? 100));
    setSaved(false);
  };

  const save = async (next: string[], bps: string) => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      // The whole record goes back, not just the edited tab. Sending one
      // profile would read as a settings object with the other two missing,
      // and they would be replaced by defaults.
      const applied = await settingsApi.set(withEdits(all ?? DEFAULT_SETTINGS, tab, next, bps));
      setAll(applied);
      setPresets([...(applied.profiles[tab]?.buyPresets ?? applied.buyPresets)]);
      setSlippage(String(applied.profiles[tab]?.slippageBps ?? applied.slippageBps));
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
    <div className="card stack">
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
    <>
      <div className="tabs">
        <button aria-selected="true">Tokens</button>
        <button
          aria-selected="false"
          onClick={() => void load()}
          disabled={loading}
          style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 550, borderBottom: 0 }}
        >
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error" style={{ margin: '0 0 10px' }}>{error}</div>}

      {!error && data && data.positions.length === 0 && (
        <div className="empty">
          <div className="big">🐰</div>
          <p>Nothing up your sleeve yet. Tokens land here once you trade them.</p>
        </div>
      )}

      {data?.positions.map((p) => (
        <div key={p.token} className="tok">
          <div className="tok-mark">{(p.symbol ?? '?').slice(0, 3).toUpperCase()}</div>
          <div className="tok-id">
            <div className="tok-name">{p.symbol ?? 'Unknown token'}</div>
            <div className="tok-qty">{p.balanceFormatted}</div>
          </div>
          <div className="tok-val">
            <div className="v">{p.valueWei !== null ? `${formatEth(p.valueWei)}` : '—'}</div>
            <div className={p.valueWei !== null ? 's' : 's bad'}>
              {p.valueWei !== null ? 'ETH' : (p.valueUnavailableReason ?? 'no quote')}
            </div>
          </div>
        </div>
      ))}

      {/* Stated, not hidden: a total that quietly omitted unsellable rows would
          read as complete. */}
      {data && data.unvalued > 0 && (
        <p className="note" style={{ paddingTop: 10 }}>
          {data.unvalued} of {data.positions.length} could not be priced, so they are missing from the balance above.
        </p>
      )}
      {data && data.positions.length > 0 && (
        <p className="note" style={{ paddingTop: 8 }}>
          Only tokens seen in Hoodini. Not a full portfolio, because there is no indexer to ask.
        </p>
      )}
    </>
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
    <div className="scroll" style={{ paddingTop: 20 }}>
      <div style={{ display: 'grid', placeItems: 'center', paddingBottom: 14 }}>
        <TopHat size={84} />
      </div>
      <h2 style={{ textAlign: 'center', margin: '0 0 4px', fontSize: 19, letterSpacing: '-0.02em' }}>
        {mode === 'create' ? 'A wallet in one step' : 'Bring your own key'}
      </h2>
      <p className="note" style={{ textAlign: 'center', marginBottom: 16 }}>
        Generated here, encrypted here, and it never leaves. Hoodini has no server to send it to.
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
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
    <div className="solo">
      <div style={{ display: 'grid', placeItems: 'center', paddingBottom: 6 }}>
        <TopHat size={132} />
      </div>
      <h2>Enter your password</h2>
      <p className="sub">{status.address ? short(status.address) : ''}</p>
      <input
        id="unlock"
        type="password"
        placeholder="Password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && password) void run(() => wallet.unlock(password));
        }}
      />
      <button className="primary" disabled={!password || busy} onClick={() => run(() => wallet.unlock(password))}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      <p className="note" style={{ textAlign: 'center' }}>
        Takes a moment. The password is deliberately slow to derive, which is what makes it worth guessing at.
      </p>
    </div>
  );
}

