/**
 * The focused trade panel.
 *
 * The row controls are for scanning a list: four buy amounts and four sell
 * fractions, mounted per card, gone the moment you scroll. This is the other
 * half — one token, held still, with the configuration visible and switchable
 * while you work it.
 *
 * Shaped after the widget Rory pinned (D-066): profile tabs, a buy row, a sell
 * row in percentages, and the config that will actually be submitted printed
 * where the buttons are rather than in a settings screen.
 *
 * ## What it deliberately does not show
 *
 * The reference prints your holding of the token beside its sell buttons. This
 * does not, and the reason is the same one that made sells percentages rather
 * than amounts (D-065): a panel injected into a page has an open shadow root,
 * so anything it renders, a hostile site can read. `positions.list` is
 * popup-only precisely so a site never learns what someone holds. Percentages
 * work without that disclosure, and the confirm sheet shows the exact amount
 * before anything is signed.
 *
 * ## What it does not do
 *
 * It holds no key, builds no calldata and signs nothing — same as the row
 * controls. It emits intents. Switching profiles here changes what *this page*
 * draws and submits for as long as the panel is open; it never writes settings,
 * because `settings.set` is popup-only so that a site cannot quietly widen what
 * a button spends and wait to be clicked.
 */

import type { TokenRef } from '@hoodini/core';
import type { IntentResult, OverlayIntent, SellUnavailable } from './overlay.js';

export const PANEL_ATTR = 'data-hoodini-panel';

export interface PanelProfile {
  readonly buyPresets: readonly string[];
  readonly slippageBps: number;
}

export interface PanelPosition {
  readonly x: number;
  readonly y: number;
}

export interface PanelOptions {
  readonly profiles: readonly PanelProfile[];
  /** Which profile opens selected. Clamped, so a bad index cannot blank the rows. */
  readonly activeProfile?: number;
  readonly sellPercents?: readonly number[];
  readonly onIntent: (intent: OverlayIntent) => void | Promise<IntentResult | void>;
  readonly probeSell?: (token: TokenRef, percent?: number) => Promise<SellUnavailable | null>;
  readonly onClose?: () => void;
  /** Where it opened last. Clamped into view, so a stale value cannot strand it. */
  readonly position?: PanelPosition;
  readonly onMove?: (position: PanelPosition) => void;
  /** Current network gas in gwei, shown under each side. Omit for an em dash. */
  readonly gasGwei?: number | null;
}

/**
 * Say the panel cannot trade this token, or clear the message.
 *
 * The panel opens as soon as a route names a coin, before anything is known
 * about whether it can be traded here — because a panel that waits for a chain
 * round trip to decide whether to exist is a panel that silently never appears
 * when the answer is no, which is indistinguishable from a broken extension.
 * That mistake cost three rounds (D-069).
 */
export function setPanelStatus(doc: Document, message: string | null): void {
  const host = doc.querySelector(`[${PANEL_ATTR}]`) as HTMLElement | null;
  const shadow = host?.shadowRoot;
  if (!shadow) return;
  const bar = shadow.querySelector('.status') as HTMLElement | null;
  if (!bar) return;
  bar.textContent = message ?? '';
  bar.hidden = message === null;
  // Nothing here can be traded while the message stands, so nothing here
  // pretends it can.
  for (const b of shadow.querySelectorAll('.grid button')) {
    (b as HTMLButtonElement).disabled = message !== null;
  }
}

const WIDTH = 300;

const STYLE = `
  :host { all: initial; }
  .panel {
    position: fixed; z-index: 2147483000; width: ${WIDTH}px;
    background: rgba(8, 11, 17, 0.94);
    color: #e9eef7;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    box-shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 18px 44px -12px rgba(0, 0, 0, .75);
    backdrop-filter: blur(14px) saturate(1.2);
    font: 500 12px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }

  .hd { display: flex; align-items: center; gap: 8px; padding: 10px 11px 9px;
        cursor: grab; user-select: none; }
  .hd.drag { cursor: grabbing; }
  .grip { color: #39415170; font-size: 9px; letter-spacing: 1px; }
  .tok { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px;
         color: #6d7789; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
         letter-spacing: .01em; }
  .tabs { display: flex; gap: 1px; background: rgba(255,255,255,.05); border-radius: 6px; padding: 1px; }
  .tabs button { all: unset; cursor: pointer; padding: 3px 8px; border-radius: 5px;
                 font-size: 10px; font-weight: 650; color: #6d7789; letter-spacing: .02em; }
  .tabs button:hover { color: #aab4c4; }
  .tabs button.on { color: #0a0f18; background: #7fb4f5; }
  .x { all: unset; cursor: pointer; color: #4a5364; padding: 1px 2px; font-size: 12px; line-height: 1; }
  .x:hover { color: #e9eef7; }

  .sec { padding: 0 12px 12px; }
  .sec.sell { border-top: 1px solid rgba(255,255,255,.05); padding-top: 12px; }
  .lbl { color: #4a5364; font-size: 9px; letter-spacing: .13em; text-transform: uppercase;
         margin-bottom: 6px; display: block; font-weight: 650; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
  .grid button {
    all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
    padding: 8px 2px; border-radius: 8px; font-size: 12px; font-weight: 650;
    letter-spacing: -.01em; transition: background-color .12s ease, color .12s ease;
  }
  /* Tinted glass rather than outlined pills: at this size a border on every
     button is most of what the eye sees, and the colour alone carries the
     buy/sell distinction perfectly well. */
  .buy button { background: rgba(70, 214, 132, .12); color: #74e6a4; }
  .buy button:hover { background: rgba(70, 214, 132, .22); color: #a6f3c6; }
  .sell button { background: rgba(255, 122, 122, .11); color: #ff9494; }
  .sell button:hover { background: rgba(255, 122, 122, .2); color: #ffbcbc; }
  .grid button:active { transform: translateY(.5px); }
  .grid button:disabled { cursor: default; opacity: .5; }
  .grid button.no { background: rgba(255,255,255,.04); color: #5d6472; }
  .grid button:focus-visible { outline: 1px solid currentColor; outline-offset: -3px; }

  /* Under each side, the way the reference puts it: what this half will submit
     with, readable without leaving the button you are about to press. */
  .stats { display: flex; align-items: center; gap: 11px; margin-top: 7px; color: #4a5364; font-size: 9.5px; }
  .stats i { font-style: normal; opacity: .65; margin-right: 3px; }
  .stats b { color: #7d8797; font-weight: 600; }
  .stats .gas { margin-left: auto; }

  .cfg { display: flex; align-items: center; gap: 6px; padding: 9px 11px;
         border-top: 1px solid rgba(255, 255, 255, .06);
         background: rgba(255,255,255,.015);
         color: #4a5364; font-size: 10px; letter-spacing: .01em; }
  .cfg .sp { flex: 1; }
  .cfg b { color: #8e99ab; font-weight: 650; }
  .cfg .zero { color: #74e6a4; font-weight: 650; }

  .status { padding: 9px 11px; font-size: 10.5px; line-height: 1.45;
            background: rgba(255, 180, 84, .1); color: #ffc178;
            border-top: 1px solid rgba(255, 180, 84, .22); }
  .status[hidden] { display: none; }
`;

/** Keep the panel on screen whatever was stored or however the window changed. */
function clamp(position: PanelPosition, view: { width: number; height: number }): PanelPosition {
  const maxX = Math.max(0, view.width - WIDTH - 8);
  const maxY = Math.max(0, view.height - 120);
  return {
    x: Math.min(Math.max(8, position.x), maxX),
    y: Math.min(Math.max(8, position.y), maxY),
  };
}

/**
 * Open the panel on a token, replacing any panel already open.
 *
 * One at a time by construction: two panels would mean two configurations on
 * screen and no way to tell which a click used.
 */
export function mountPanel(doc: Document, token: TokenRef, options: PanelOptions): HTMLElement {
  unmountPanel(doc);

  const host = doc.createElement('div');
  host.setAttribute(PANEL_ATTR, '');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  shadow.appendChild(style);

  const panel = doc.createElement('div');
  panel.className = 'panel';

  const view = { width: doc.defaultView?.innerWidth ?? 1280, height: doc.defaultView?.innerHeight ?? 800 };
  let at = clamp(options.position ?? { x: view.width - WIDTH - 24, y: 96 }, view);
  panel.style.left = `${at.x}px`;
  panel.style.top = `${at.y}px`;

  // ── header ───────────────────────────────────────────────────────────────
  const hd = doc.createElement('div');
  hd.className = 'hd';
  const grip = doc.createElement('span');
  grip.className = 'grip';
  grip.textContent = '⣿';
  const label = doc.createElement('span');
  label.className = 'tok';
  label.textContent = `${token.address.slice(0, 6)}…${token.address.slice(-4)}`;
  label.title = token.address;
  hd.append(grip, label);

  let active = Math.min(Math.max(0, options.activeProfile ?? 0), options.profiles.length - 1);
  const tabs = doc.createElement('span');
  tabs.className = 'tabs';
  const tabButtons: HTMLButtonElement[] = [];
  options.profiles.forEach((_, i) => {
    const t = doc.createElement('button');
    t.textContent = `P${i + 1}`;
    t.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      active = i;
      tabButtons.forEach((b, j) => b.classList.toggle('on', j === i));
      render();
    });
    tabButtons.push(t);
    tabs.appendChild(t);
  });
  tabButtons.forEach((b, j) => b.classList.toggle('on', j === active));
  hd.appendChild(tabs);

  const close = doc.createElement('button');
  close.className = 'x';
  close.textContent = '✕';
  close.title = 'Close';
  close.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    unmountPanel(doc);
    options.onClose?.();
  });
  hd.appendChild(close);
  panel.appendChild(hd);

  // ── rows, redrawn when the profile changes ───────────────────────────────
  const buySec = doc.createElement('div');
  buySec.className = 'sec';
  const sellSec = doc.createElement('div');
  sellSec.className = 'sec sell';
  const status = doc.createElement('div');
  status.className = 'status';
  status.hidden = true;

  const cfg = doc.createElement('div');
  cfg.className = 'cfg';
  panel.append(buySec, sellSec, status, cfg);

  /**
   * The figures this side will actually submit with.
   *
   * Slippage and gas, and nothing else. The reference shows a priority fee and
   * a tip beside them; this chain is an Orbit L2 with a sequencer and has no
   * fee auction to bid into, so those two fields would be decoration shaped
   * like information (D-069).
   */
  function statRow(profile: PanelProfile): HTMLElement {
    const row = doc.createElement('div');
    row.className = 'stats';

    const slip = doc.createElement('span');
    const slipIcon = doc.createElement('i');
    slipIcon.textContent = '⇄';
    const slipVal = doc.createElement('b');
    slipVal.textContent = `${(profile.slippageBps / 100).toFixed(2).replace(/\.00$/, '')}%`;
    slip.append(slipIcon, slipVal);
    slip.title = 'Max slippage';

    const gas = doc.createElement('span');
    gas.className = 'gas';
    const gasIcon = doc.createElement('i');
    gasIcon.textContent = '⛽';
    const gasVal = doc.createElement('b');
    // Absent until the caller supplies one. A fabricated gas figure on a
    // trading panel is worse than none.
    gasVal.textContent = options.gasGwei != null ? `${options.gasGwei} gwei` : '—';
    gas.append(gasIcon, gasVal);
    gas.title = 'Network gas, paid to the sequencer either way';

    row.append(slip, gas);
    return row;
  }

  function render(): void {
    const profile = options.profiles[active] ?? { buyPresets: [], slippageBps: 100 };

    buySec.replaceChildren();
    const bl = doc.createElement('span');
    bl.className = 'lbl';
    bl.textContent = 'Buy · ETH';
    const bg = doc.createElement('div');
    bg.className = 'grid buy';
    // Fit the columns to the profile. A fixed four leaves a hole beside a
    // three-preset profile and squeezes a two-preset one into quarter-width
    // buttons; both look like a mistake rather than a configuration.
    bg.style.gridTemplateColumns = `repeat(${Math.max(1, Math.min(4, profile.buyPresets.length))}, 1fr)`;
    bg.style.gap = '5px';
    for (const amount of profile.buyPresets) {
      const b = doc.createElement('button');
      b.textContent = amount;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        reflect(b, amount, options.onIntent({ side: 'buy', token, amount }));
      });
      bg.appendChild(b);
    }
    buySec.append(bl, bg, statRow(profile));

    sellSec.replaceChildren();
    const sl = doc.createElement('span');
    sl.className = 'lbl';
    sl.textContent = 'Sell · % of holding';
    const sg = doc.createElement('div');
    sg.className = 'grid sell';
    for (const percent of options.sellPercents ?? [25, 50, 75, 100]) {
      const b = doc.createElement('button');
      b.textContent = `${percent}%`;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (b.disabled) return;
        if (!options.probeSell) {
          reflect(b, `${percent}%`, options.onIntent({ side: 'sell', token, percent }));
          return;
        }
        b.disabled = true;
        const was = b.textContent;
        b.textContent = '…';
        void options
          .probeSell(token, percent)
          .then((no) => {
            if (!no) {
              b.disabled = false;
              b.textContent = was;
              reflect(b, was, options.onIntent({ side: 'sell', token, percent }));
              return;
            }
            // Only this size is refused. Availability is size-dependent
            // (D-049), so the other fractions stay live.
            b.textContent = '×';
            b.title = no.reason;
            b.classList.add('no');
          })
          .catch(() => {
            b.disabled = false;
            b.textContent = was;
          });
      });
      sg.appendChild(b);
    }
    sellSec.append(sl, sg, statRow(profile));

    cfg.replaceChildren();
    const slip = doc.createElement('span');
    slip.textContent = 'Slippage';
    const val = doc.createElement('b');
    val.textContent = `${(profile.slippageBps / 100).toFixed(2).replace(/\.00$/, '')}%`;
    const spacer = doc.createElement('span');
    spacer.className = 'sp';
    const feeLabel = doc.createElement('span');
    feeLabel.textContent = 'Fee';
    const fee = doc.createElement('span');
    fee.className = 'zero';
    fee.textContent = '0%';
    cfg.append(slip, val, spacer, feeLabel, fee);
  }
  render();

  /** Show an outcome on the button that caused it, then put it back. */
  function reflect(button: HTMLButtonElement, label: string, result: void | Promise<IntentResult | void>): void {
    if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return;
    button.disabled = true;
    button.textContent = '…';
    void (result as Promise<IntentResult | void>)
      .then((r) => {
        button.textContent = (r && typeof r === 'object' ? r.message : undefined) ?? label;
      })
      .catch(() => {
        button.textContent = 'failed';
      })
      .finally(() => {
        setTimeout(() => {
          button.textContent = label;
          button.disabled = false;
        }, 2200);
      });
  }

  // ── dragging ─────────────────────────────────────────────────────────────
  let from: { x: number; y: number; ox: number; oy: number } | null = null;
  hd.addEventListener('pointerdown', (e) => {
    // Only the header, and never a control inside it.
    if ((e.target as Element)?.closest('button')) return;
    from = { x: e.clientX, y: e.clientY, ox: at.x, oy: at.y };
    hd.classList.add('drag');
    hd.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  hd.addEventListener('pointermove', (e) => {
    if (!from) return;
    at = clamp({ x: from.ox + (e.clientX - from.x), y: from.oy + (e.clientY - from.y) }, {
      width: doc.defaultView?.innerWidth ?? view.width,
      height: doc.defaultView?.innerHeight ?? view.height,
    });
    panel.style.left = `${at.x}px`;
    panel.style.top = `${at.y}px`;
  });
  const end = (e: PointerEvent) => {
    if (!from) return;
    from = null;
    hd.classList.remove('drag');
    hd.releasePointerCapture?.(e.pointerId);
    // Reported on release rather than on every move: a caller that persists
    // this should not be asked to write storage sixty times a second.
    options.onMove?.(at);
  };
  hd.addEventListener('pointerup', end);
  hd.addEventListener('pointercancel', end);

  shadow.appendChild(panel);
  doc.body.appendChild(host);
  return host;
}

/** Close it, if one is open. Returns whether there was. */
export function unmountPanel(doc: Document): boolean {
  const open = doc.querySelector(`[${PANEL_ATTR}]`);
  if (!open) return false;
  open.remove();
  return true;
}
