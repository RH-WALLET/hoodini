/**
 * Axiom adapter — NOT IMPLEMENTED.
 *
 * Axiom is the confirmed first terminal target (DATA_SOURCES.md §8), but its
 * markup has not been observed: the site sits behind Cloudflare bot protection,
 * so it cannot be fetched by automation, and defeating bot detection is not
 * something this project does.
 *
 * Writing selectors against a page nobody has seen would produce an adapter
 * that looks finished, silently matches nothing, and fails in a way no test
 * here could catch. So this stays a stub until a DOM snapshot exists.
 *
 * ## To finish it
 *
 * 1. Open Axiom, paste `scripts/capture-dom.js` into the devtools console.
 * 2. Save the output to `docs/dom/axiom.trade.json`.
 * 3. Replace the selectors below and delete the throw.
 *
 * Everything else is already built: detection, row-finding, the shadow-DOM
 * overlay and the runtime are site-agnostic and tested. This file is the thin
 * layer that says *where* on Axiom a control belongs.
 *
 * `GenericAddressAdapter` works on Axiom today wherever it renders raw
 * addresses, so the site is not unsupported in the meantime — just not
 * first-class.
 */

import type { TokenRef } from '@hoodini/core';
import type { SiteAdapter } from '../site.js';

export class AxiomAdapterNotReady extends Error {
  constructor() {
    super(
      'axiom adapter is not implemented: no DOM snapshot yet. ' +
        'Run scripts/capture-dom.js on axiom.trade and save docs/dom/axiom.trade.json.',
    );
    this.name = 'AxiomAdapterNotReady';
  }
}

/** Placeholder so the wiring compiles and the gap is impossible to miss. */
export class AxiomAdapter implements SiteAdapter {
  readonly id = 'axiom';
  readonly siteMatch = new URLPattern({ hostname: 'axiom.trade' });

  detectTokens(): TokenRef[] {
    throw new AxiomAdapterNotReady();
  }

  findAnchors(): Element[] {
    throw new AxiomAdapterNotReady();
  }

  mount(): void {
    throw new AxiomAdapterNotReady();
  }
}
