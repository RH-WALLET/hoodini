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
}

const WIDTH = 268;

const STYLE = `
  :host { all: initial; }
  .panel {
    position: fixed; z-index: 2147483000; width: ${WIDTH}px;
    background: rgba(10, 15, 24, 0.97); color: #e9eef7;
    border: 1px solid #2a3648; border-radius: 12px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.62);
    font: 500 12px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .hd { display: flex; align-items: center; gap: 7px; padding: 8px 9px;
        border-bottom: 1px solid #1a2433; cursor: grab; user-select: none; }
  .hd.drag { cursor: grabbing; }
  .grip { color: #5a6880; font-size: 12px; letter-spacing: -2px; }
  .tok { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
         color: #8493aa; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tabs { display: flex; gap: 3px; }
  .tabs button { all: unset; cursor: pointer; padding: 2px 7px; border-radius: 5px;
                 font-size: 10.5px; font-weight: 650; color: #5a6880; border: 1px solid transparent; }
  .tabs button:hover { color: #8493aa; }
  .tabs button.on { color: #4da3ff; border-color: #4da3ff; background: rgba(77,163,255,.12); }
  .x { all: unset; cursor: pointer; color: #5a6880; padding: 0 3px; font-size: 14px; line-height: 1; }
  .x:hover { color: #e9eef7; }

  .sec { padding: 9px; }
  .sec + .sec { border-top: 1px solid #1a2433; }
  .lbl { color: #5a6880; font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
         margin-bottom: 7px; display: block; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
  .grid button {
    all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
    padding: 7px 2px; border-radius: 7px; font-size: 12px; font-weight: 600;
  }
  .buy button { border: 1px solid #2b6b46; background: #10371f; color: #7bf1a8; }
  .buy button:hover { background: #1d6640; }
  .sell button { border: 1px solid #6b2b2b; background: #371010; color: #ff9a9a; }
  .sell button:hover { background: #521818; }
  .grid button:disabled { cursor: default; opacity: .55; }
  .grid button.no { border-color: #3a3f4a; background: #1a1c21; color: #6f7787; }

  .cfg { display: flex; justify-content: space-between; padding: 7px 9px;
         border-top: 1px solid #1a2433; color: #5a6880; font-size: 10.5px; }
  .cfg b { color: #8493aa; font-weight: 600; }
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
  sellSec.className = 'sec';
  const cfg = doc.createElement('div');
  cfg.className = 'cfg';
  panel.append(buySec, sellSec, cfg);

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
    buySec.append(bl, bg);

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
    sellSec.append(sl, sg);

    cfg.replaceChildren();
    const slip = doc.createElement('span');
    slip.textContent = 'Max slippage';
    const val = doc.createElement('b');
    val.textContent = `${(profile.slippageBps / 100).toFixed(2).replace(/\.00$/, '')}%`;
    const fee = doc.createElement('span');
    fee.textContent = 'Hoodini fee 0%';
    cfg.append(slip, val, fee);
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
