/**
 * The injected control.
 *
 * Rendered into a **shadow root**, which is the whole point: a trading terminal
 * ships aggressive global CSS, and without isolation their stylesheet would
 * reshape our buttons while ours leaked back into their layout. Shadow DOM
 * makes both impossible without either side cooperating.
 *
 * The control never holds a key, never builds calldata, and never signs. It
 * emits an intent; the service worker decides what to do with it.
 */

import type { TokenRef } from '@hoodini/core';

/** Marks a host so a re-scan can recognise its own work (idempotent mounting). */
export const HOST_ATTR = 'data-hoodini';
/** Records which token a host is currently bound to. */
export const TOKEN_ATTR = 'data-hoodini-token';

export interface OverlayIntent {
  readonly side: 'buy' | 'sell';
  readonly token: TokenRef;
  /**
   * Fraction of the holding to sell, 1–100. Sells only.
   *
   * A percentage rather than an amount because this control lives in the page's
   * world, and telling it the balance would tell the site the balance — the
   * exact disclosure `positions.list` is popup-only to prevent. "Sell half" is
   * actionable without anyone here knowing half of what (D-065).
   */
  readonly percent?: number;
  /**
   * The preset the user actually pressed, in ETH.
   *
   * Absent on a sell, which is always the whole balance (D-049).
   *
   * This was missing until the control was seen working: the buttons rendered
   * one per preset, but every one of them emitted the same intent, so a click
   * on `0.01` quoted the content script's hardcoded 0.001. The amounts were
   * decoration. Nothing downstream could have caught it, because nothing
   * downstream was ever told which button was pressed.
   */
  readonly amount?: string;
}

/** Why a sell cannot proceed, in words a user can act on. */
export type SellUnavailable = { readonly reason: string };

/**
 * What became of an intent, for showing on the button that raised it.
 *
 * Optional by design. An overlay whose handler answers nothing still works
 * exactly as before — this exists so the confirm flow can say "now go and
 * approve it" without the user wondering whether their click registered.
 */
export interface IntentResult {
  readonly ok: boolean;
  /** Short enough to fit on a button. Shown verbatim, so no jargon. */
  readonly message?: string;
}

/**
 * Show an intent's outcome on the button that raised it, then restore it.
 *
 * The button is disabled while in flight: a trade request that a page could
 * fire twice by double click is a second proposal the user has to dismiss.
 */
function reflect(button: HTMLButtonElement, label: string, result: Promise<IntentResult | void>): void {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '…';
  void result
    .then((r) => {
      const message = r && typeof r === 'object' ? r.message : undefined;
      button.textContent = message ?? label;
      if (r && typeof r === 'object' && !r.ok) button.classList.add('unavailable');
    })
    .catch(() => {
      button.textContent = 'failed';
      button.classList.add('unavailable');
    })
    .finally(() => {
      // Restored after a beat so the outcome is readable, and so a click that
      // failed for a transient reason can simply be repeated.
      setTimeout(() => {
        button.textContent = label;
        button.classList.remove('unavailable');
        button.disabled = false;
      }, 2500);
    });
}

/**
 * Where the control sits inside its anchor.
 *
 * Appending into the flow is right for a tweet or a table row, which grow to
 * fit. It is wrong for a terminal card: those are fixed-height, lay their
 * contents out absolutely, and clip the overflow. On Axiom the result was a
 * 19px control at offset 110px in a 115px card clipping at 116px — visibly
 * sliced in half, and for the second card cut off entirely.
 *
 * An adapter that knows it is decorating such a card passes a placement, and
 * the host is positioned against the anchor instead. The anchor must establish
 * a containing block; every terminal card observed so far is `position:
 * relative` already, and this deliberately does not restyle the page to force
 * that — mutating a site's layout to fit our button is not a trade this
 * project makes.
 */
export interface OverlayPlacement {
  readonly top?: string;
  readonly right?: string;
  readonly bottom?: string;
  readonly left?: string;
}

export interface OverlayOptions {
  /** Preset buy amounts in ETH, shown as quick buttons. */
  readonly amounts?: readonly string[];
  /**
   * Sell fractions, shown as a second row. Defaults to 25/50/75/100.
   *
   * Empty disables them and restores the single whole-balance Sell button, so
   * an adapter with no room for two rows is not forced into one.
   */
  readonly sellPercents?: readonly number[];
  /**
   * Shown small beneath the buttons: what this click will actually submit with.
   *
   * The reference terminals all do this, and the reason is good — slippage
   * living in a settings screen means nobody can see what they are about to
   * agree to at the moment they agree to it.
   */
  readonly config?: { readonly slippageBps: number };
  /**
   * Handle a click. May answer with an outcome to show on the button; a
   * `void` return keeps the original fire-and-forget behaviour.
   */
  readonly onIntent: (intent: OverlayIntent) => void | Promise<IntentResult | void>;
  /** Rendered next to the controls when a quote is available. */
  readonly label?: string;
  /**
   * Confirm a sell is actually possible before emitting the intent.
   *
   * Three venues have pools whose sell quote reverts while buys work fine
   * (D-021, D-033, D-043), so a Sell button that always renders is a button
   * that sometimes cannot work. Resolve `null` when the sell can proceed, or a
   * reason when it cannot.
   *
   * Probed on click rather than on mount: a list of fifty rows would otherwise
   * fire fifty quotes nobody asked for. And availability is size-dependent, so
   * the probe must price the amount that would really be sold.
   */
  readonly probeSell?: (token: TokenRef, percent?: number) => Promise<SellUnavailable | null>;
  /** Position against the anchor rather than flowing after its content. */
  readonly placement?: OverlayPlacement;
  /**
   * Called once, the first time the pointer enters this control.
   *
   * For warming whatever the worker would otherwise compute on click —
   * resolving the token's venue costs a round trip per adapter the first time
   * and nothing afterwards (D-057), so paying it on hover makes the click feel
   * instant.
   *
   * **On hover, not on mount.** D-049 already rejected mount-time probing: a
   * column of fifty rows would fire fifty requests nobody asked for. Hover is
   * intent, it is one row at a time, and it arrives a few hundred milliseconds
   * before the click — which is the whole window needed.
   */
  readonly onWarm?: (token: TokenRef) => void;
  /**
   * Open the focused panel for this token.
   *
   * Renders a small expander at the end of the bar. Absent means no expander,
   * which is how a surface with no room for one opts out (D-066).
   */
  readonly onExpand?: (token: TokenRef) => void;
}

/**
 * A terminal card has no free space — every edge is already a stat row. Axiom
 * solves that for its own quick-buy by floating it over the content on hover.
 * Ours stays visible, so it needs to read as a distinct layer rather than as
 * more of the page: hence the panel background and border behind the buttons.
 */
const STYLE = `
  :host { all: initial; display: inline-flex; vertical-align: middle; }
  .bar { display: inline-flex; gap: 5px; align-items: center;
         font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
         background: rgba(9, 9, 11, 0.94); padding: 4px; border-radius: 9px;
         border: 1px solid rgba(255, 255, 255, 0.10);
         box-shadow: 0 3px 10px rgba(0, 0, 0, 0.55); }
  button { all: unset; box-sizing: border-box; cursor: pointer;
           padding: 6px 11px; border-radius: 6px; border: 1px solid #2b6b46;
           background: #10371f; color: #7bf1a8; white-space: nowrap;
           line-height: 1; }
  button:hover { background: #1d6640; border-color: #3f9c68; }
  button:active { transform: translateY(1px); }
  button:focus-visible { outline: 2px solid #7bf1a8; outline-offset: 1px; }
  button.sell { border-color: #6b2b2b; background: #371010; color: #ff9a9a; }
  button.sell:hover { background: #521818; border-color: #a04141; }
  button.unavailable { border-color: #3a3f4a; background: #1a1c21; color: #6f7787; cursor: not-allowed; }
  button:disabled { cursor: default; opacity: 0.75; }
  .label { color: #8b93a5; font-size: 11px; padding-right: 2px; }
  button.expand { padding: 6px 8px; border-color: #2a3648; background: #121a27; color: #8493aa;
                  font-size: 11px; line-height: 1; }
  button.expand:hover { border-color: #4da3ff; color: #e9eef7; }
  .cfg { color: #6f7787; font-size: 10px; padding: 0 2px; border-left: 1px solid rgba(255,255,255,.09);
         margin-left: 2px; padding-left: 6px; }
`;

/**
 * Mount (or re-mount) the control on `anchor`.
 *
 * Idempotent by contract: SPA re-renders call this repeatedly for the same
 * node, and virtualised lists recycle a node for a *different* token, so an
 * existing host is rebound rather than duplicated.
 */
export function mountOverlay(anchor: Element, token: TokenRef, options: OverlayOptions): HTMLElement {
  const doc = anchor.ownerDocument;
  const existing = anchor.querySelector(`:scope > [${HOST_ATTR}]`) as HTMLElement | null;

  if (existing) {
    // Same node, same token: nothing to do. Rebuilding would drop focus and
    // restart any in-flight interaction for no reason.
    if (existing.getAttribute(TOKEN_ATTR) === token.address.toLowerCase()) return existing;
    existing.remove();
  }

  const host = doc.createElement('span');
  host.setAttribute(HOST_ATTR, '');
  host.setAttribute(TOKEN_ATTR, token.address.toLowerCase());

  if (options.placement) {
    const p = options.placement;
    // Inline styles, not a `:host` rule — `:host { all: initial }` would reset
    // position back to static, and inline wins over both that and the page.
    host.style.position = 'absolute';
    if (p.top !== undefined) host.style.top = p.top;
    if (p.right !== undefined) host.style.right = p.right;
    if (p.bottom !== undefined) host.style.bottom = p.bottom;
    if (p.left !== undefined) host.style.left = p.left;
    // Axiom stacks its own controls at z-30 and z-50 within the card, and the
    // placement diagnostic found ours painted underneath them.
    host.style.zIndex = '2147483000';
    host.style.pointerEvents = 'auto';
  }

  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  shadow.appendChild(style);

  const bar = doc.createElement('span');
  bar.className = 'bar';

  for (const amount of options.amounts ?? ['0.001', '0.01']) {
    const b = doc.createElement('button');
    b.textContent = `${amount}`;
    b.setAttribute('part', 'buy');
    b.addEventListener('click', (e) => {
      // The page may have its own handler on the row; a click on our control
      // is ours alone.
      e.preventDefault();
      e.stopPropagation();
      const result = options.onIntent({ side: 'buy', token, amount });
      // A handler that reports back gets its outcome shown on the button. One
      // that does not keeps the old fire-and-forget behaviour, so nothing that
      // already worked has to change.
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        reflect(b, amount, result as Promise<IntentResult | void>);
      }
    });
    bar.appendChild(b);
  }

  /**
   * Sells, as fractions of the holding.
   *
   * Each carries its own probe: availability is size-dependent (D-049), so a
   * venue that pays out 25% may still revert on 100%, and one button standing
   * for all four would be a button that is sometimes lying.
   */
  const percents = options.sellPercents ?? [25, 50, 75, 100];
  for (const percent of percents) {
    const b = doc.createElement('button');
    b.className = 'sell';
    b.textContent = `${percent}%`;
    const label = b.textContent;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // No probe supplied: emit as before. Callers that can check are expected
      // to, and the content script does.
      if (!options.probeSell) {
        options.onIntent({ side: 'sell', token, percent });
        return;
      }
      if (b.disabled) return;

      b.disabled = true;
      b.textContent = '…';
      void options
        .probeSell(token, percent)
        .then((unavailable) => {
          if (!unavailable) {
            b.disabled = false;
            b.textContent = label;
            options.onIntent({ side: 'sell', token, percent });
            return;
          }
          // Stays disabled and says why. Re-enabling would invite a second
          // click that fails identically — and only this size is refused, so
          // the other fractions stay live.
          b.textContent = '×';
          b.title = unavailable.reason;
          b.classList.add('unavailable');
        })
        .catch(() => {
          // A probe that itself fails is not proof a sell would fail, so the
          // button goes back to normal rather than accusing the venue.
          b.disabled = false;
          b.textContent = label;
        });
    });
    bar.appendChild(b);
  }

  if (options.label) {
    const label = doc.createElement('span');
    label.className = 'label';
    label.textContent = options.label;
    bar.appendChild(label);
  }

  if (options.onExpand) {
    const expand = doc.createElement('button');
    expand.className = 'expand';
    expand.textContent = '⤢';
    expand.title = 'Open the trade panel';
    expand.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      options.onExpand?.(token);
    });
    bar.appendChild(expand);
  }

  if (options.config) {
    const cfg = doc.createElement('span');
    cfg.className = 'cfg';
    cfg.textContent = `${(options.config.slippageBps / 100).toFixed(2).replace(/\.00$/, '')}%`;
    cfg.title = 'Max slippage on this trade';
    bar.appendChild(cfg);
  }

  if (options.onWarm) {
    const warm = options.onWarm;
    // `once`: hovering back and forth over a row must not become a request per
    // pass. The worker caches what this warms, so a second call would be waste
    // even if it were free.
    host.addEventListener('pointerenter', () => warm(token), { once: true });
  }

  shadow.appendChild(bar);
  anchor.appendChild(host);
  return host;
}

/** Remove every control this extension added, leaving the page as it was. */
export function unmountAll(root: ParentNode): number {
  const hosts = root.querySelectorAll(`[${HOST_ATTR}]`);
  hosts.forEach((h) => h.remove());
  return hosts.length;
}
