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
}

/** Why a sell cannot proceed, in words a user can act on. */
export type SellUnavailable = { readonly reason: string };

export interface OverlayOptions {
  /** Preset buy amounts in ETH, shown as quick buttons. */
  readonly amounts?: readonly string[];
  readonly onIntent: (intent: OverlayIntent) => void;
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
  readonly probeSell?: (token: TokenRef) => Promise<SellUnavailable | null>;
}

const STYLE = `
  :host { all: initial; display: inline-flex; vertical-align: middle; }
  .bar { display: inline-flex; gap: 4px; align-items: center;
         font: 500 11px/1 ui-sans-serif, system-ui, sans-serif; }
  button { all: unset; box-sizing: border-box; cursor: pointer;
           padding: 3px 7px; border-radius: 5px; border: 1px solid #2b6b46;
           background: #10371f; color: #7bf1a8; white-space: nowrap; }
  button:hover { background: #175030; }
  button:focus-visible { outline: 2px solid #7bf1a8; outline-offset: 1px; }
  button.sell { border-color: #6b2b2b; background: #371010; color: #ff9a9a; }
  button.unavailable { border-color: #3a3f4a; background: #1a1c21; color: #6f7787; cursor: not-allowed; }
  button:disabled { cursor: default; opacity: 0.75; }
  .label { color: #8b93a5; font-size: 10px; }
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
      options.onIntent({ side: 'buy', token });
    });
    bar.appendChild(b);
  }

  const sell = doc.createElement('button');
  sell.className = 'sell';
  sell.textContent = 'Sell';
  sell.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // No probe supplied: emit as before. Callers that can check are expected
    // to, and the content script does.
    if (!options.probeSell) {
      options.onIntent({ side: 'sell', token });
      return;
    }
    if (sell.disabled) return;

    sell.disabled = true;
    const previous = sell.textContent;
    sell.textContent = '…';
    void options
      .probeSell(token)
      .then((unavailable) => {
        if (!unavailable) {
          sell.disabled = false;
          sell.textContent = previous;
          options.onIntent({ side: 'sell', token });
          return;
        }
        // Stays disabled and says why. Re-enabling would invite a second click
        // that fails identically.
        sell.textContent = "can't sell";
        sell.title = unavailable.reason;
        sell.classList.add('unavailable');
      })
      .catch(() => {
        // A probe that itself fails is not proof a sell would fail, so the
        // button goes back to normal rather than accusing the venue.
        sell.disabled = false;
        sell.textContent = previous;
      });
  });
  bar.appendChild(sell);

  if (options.label) {
    const label = doc.createElement('span');
    label.className = 'label';
    label.textContent = options.label;
    bar.appendChild(label);
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
