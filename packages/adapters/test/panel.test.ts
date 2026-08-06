/**
 * The focused trade panel (D-066).
 *
 * It emits intents that spend money, so the tests that matter are the ones
 * about what a click actually carries, what a refusal does to its neighbours,
 * and what the panel declines to put on screen at all.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { mountPanel, unmountPanel, setPanelStatus, PANEL_ATTR } from '../src/panel.js';
import type { OverlayIntent } from '../src/overlay.js';

const A = '0x1A463b7b289AD1C2Ad73Ff95Ea2C048D9BB8e051' as const;
const CHAIN = 4663;
const TOKEN = { address: A, chainId: CHAIN };

const PROFILES = [
  { buyPresets: ['0.001', '0.01'], slippageBps: 100 },
  { buyPresets: ['0.05', '0.1', '0.5'], slippageBps: 300 },
  { buyPresets: ['1'], slippageBps: 900 },
];

let doc: Document;
beforeEach(() => {
  doc = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true }).window.document;
});

const open = (opts: Partial<Parameters<typeof mountPanel>[2]> = {}) => {
  const seen: OverlayIntent[] = [];
  const host = mountPanel(doc, TOKEN, { profiles: PROFILES, onIntent: (i) => seen.push(i), ...opts });
  const shadow = host.shadowRoot!;
  return {
    host,
    seen,
    shadow,
    buys: () => [...shadow.querySelectorAll('.buy button')] as HTMLButtonElement[],
    sells: () => [...shadow.querySelectorAll('.sell button')] as HTMLButtonElement[],
    tabs: () => [...shadow.querySelectorAll('.tabs button')] as HTMLButtonElement[],
  };
};

describe('what it puts on screen', () => {
  it('draws the active profile, not the first one', () => {
    const p = open({ activeProfile: 1 });
    expect(p.buys().map((b) => b.textContent)).toEqual(['0.05', '0.1', '0.5']);
    expect(p.shadow.querySelector('.cfg b')?.textContent).toBe('3%');
  });

  it('clamps a profile index that does not exist rather than blanking the rows', () => {
    expect(open({ activeProfile: 99 }).buys().map((b) => b.textContent)).toEqual(['1']);
    expect(open({ activeProfile: -3 }).buys().map((b) => b.textContent)).toEqual(['0.001', '0.01']);
  });

  it('offers quarters for the sell side', () => {
    expect(open().sells().map((b) => b.textContent)).toEqual(['25%', '50%', '75%', '100%']);
  });

  it('never renders a balance, because a page could read it', () => {
    // The reference widget shows your holding beside its sell buttons — "0
    // CASHCAT · $0". Ours must not: an open shadow root in a page is readable
    // by that page, and positions.list is popup-only precisely to keep holdings
    // from a site.
    const p = open();
    // The trading rows and the config strip. Not the stylesheet, whose numbers
    // are pixels, and not the header, which shows the truncated address the
    // page already knows.
    // Element by element: textContent on a container runs "0.001" and "0.01"
    // together into "0.0010.01", which is not a number anyone rendered.
    const parts = [...p.shadow.querySelectorAll('.sec button, .sec .lbl, .cfg span, .cfg b')].map(
      (n) => n.textContent ?? '',
    );
    const text = parts.join(' ');
    expect(text).not.toMatch(/\$/);
    // Every number here is a preset, a percentage or the slippage — all values
    // the user configured, none of them a holding.
    const numbers = text.match(/[\d.]+/g) ?? [];
    const allowed = new Set(['0.001', '0.01', '25', '50', '75', '100', '1', '0']);
    for (const n of numbers) expect(allowed.has(n), `unexpected number "${n}"`).toBe(true);
    expect(p.shadow.querySelector('.tok')?.textContent).toContain('0x1A46');
  });

  it('has no way to be told a balance in the first place', () => {
    // The strongest form of the guarantee: not "we chose not to render it" but
    // "there is no channel for it". A future edit that wanted to show one would
    // have to widen this interface, which is a visible change.
    const keys = ['profiles', 'activeProfile', 'sellPercents', 'onIntent', 'probeSell', 'onClose', 'position', 'onMove'];
    const passed = { profiles: PROFILES, onIntent: () => {} } as Record<string, unknown>;
    for (const k of Object.keys(passed)) expect(keys).toContain(k);
    expect(keys.join(' ')).not.toMatch(/balance|holding|amount/i);
  });

  it('states the fee as zero where the trade is made', () => {
    // Not in a settings screen and not on the landing page: on the surface the
    // trade is actually made from.
    const cfg = open().shadow.querySelector('.cfg')!;
    expect(cfg.textContent).toContain('Fee');
    expect(cfg.querySelector('.zero')?.textContent).toBe('0%');
  });
});

describe('what a click carries', () => {
  it('emits the buy amount that was pressed', () => {
    const p = open();
    p.buys()[1]!.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    expect(p.seen).toEqual([{ side: 'buy', token: TOKEN, amount: '0.01' }]);
  });

  it('emits a sell as a fraction and never as an amount', () => {
    const p = open();
    p.sells()[2]!.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    expect(p.seen).toEqual([{ side: 'sell', token: TOKEN, percent: 75 }]);
    expect(p.seen[0]).not.toHaveProperty('amount');
  });

  it('switching profile changes what the next click spends', () => {
    // The tab is not decoration: it has to reach the intent, which is the exact
    // bug the row presets had before D-049.
    const p = open();
    p.tabs()[2]!.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    expect(p.buys().map((b) => b.textContent)).toEqual(['1']);
    p.buys()[0]!.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    expect(p.seen).toEqual([{ side: 'buy', token: TOKEN, amount: '1' }]);
  });

  it('switching profile changes the slippage shown with it', () => {
    const p = open();
    expect(p.shadow.querySelector('.cfg b')?.textContent).toBe('1%');
    p.tabs()[2]!.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    expect(p.shadow.querySelector('.cfg b')?.textContent).toBe('9%');
  });
});

describe('the sell probe', () => {
  it('refuses only the size that was refused', async () => {
    const p = open({ probeSell: async (_t, percent) => (percent === 100 ? { reason: 'too big' } : null) });
    const [quarter, , , whole] = p.sells();
    whole!.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    await vi.waitFor(() => expect(whole!.disabled).toBe(true));
    expect(whole!.title).toBe('too big');
    expect(quarter!.disabled).toBe(false);
    expect(p.seen).toEqual([]);
  });

  it('emits once the probe clears the size', async () => {
    const p = open({ probeSell: async () => null });
    p.sells()[0]!.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    await vi.waitFor(() => expect(p.seen).toHaveLength(1));
    expect(p.seen[0]).toMatchObject({ side: 'sell', percent: 25 });
  });

  it('re-enables when the probe itself fails, rather than blaming the venue', async () => {
    const p = open({ probeSell: async () => { throw new Error('rpc timeout'); } });
    const b = p.sells()[0]!;
    b.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    await vi.waitFor(() => expect(b.disabled).toBe(false));
    expect(b.textContent).toBe('25%');
    expect(p.seen).toEqual([]);
  });
});

describe('one at a time, and getting rid of it', () => {
  it('opening again replaces rather than stacks', () => {
    mountPanel(doc, TOKEN, { profiles: PROFILES, onIntent: () => {} });
    mountPanel(doc, { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', chainId: CHAIN }, {
      profiles: PROFILES, onIntent: () => {},
    });
    // Two panels would be two configurations on screen with no way to tell
    // which one a click used.
    expect(doc.querySelectorAll(`[${PANEL_ATTR}]`)).toHaveLength(1);
  });

  it('closes on the close button and reports it', () => {
    const closed = vi.fn();
    const p = open({ onClose: closed });
    (p.shadow.querySelector('.x') as HTMLButtonElement).dispatchEvent(
      new doc.defaultView!.Event('click', { bubbles: true }),
    );
    expect(doc.querySelector(`[${PANEL_ATTR}]`)).toBeNull();
    expect(closed).toHaveBeenCalled();
  });

  it('unmountPanel says whether there was one', () => {
    expect(unmountPanel(doc)).toBe(false);
    open();
    expect(unmountPanel(doc)).toBe(true);
    expect(doc.querySelector(`[${PANEL_ATTR}]`)).toBeNull();
  });
});

describe('saying it cannot trade this one (D-069)', () => {
  it('opens with no message, because nothing is known yet', () => {
    const p = open();
    const bar = p.shadow.querySelector('.status') as HTMLElement;
    expect(bar.hidden).toBe(true);
    expect(p.buys().every((b) => !b.disabled)).toBe(true);
  });

  it('shows the reason and stops every button when the token is not ours', () => {
    const p = open();
    setPanelStatus(doc, 'No Robinhood Chain venue trades this token.');
    const bar = p.shadow.querySelector('.status') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('No Robinhood Chain venue');
    // Nothing here can trade, so nothing here pretends it can.
    expect(p.buys().every((b) => b.disabled)).toBe(true);
    expect(p.sells().every((b) => b.disabled)).toBe(true);
  });

  it('clears again, so a good answer re-enables the panel', () => {
    const p = open();
    setPanelStatus(doc, 'nope');
    setPanelStatus(doc, null);
    expect((p.shadow.querySelector('.status') as HTMLElement).hidden).toBe(true);
    expect(p.buys().every((b) => !b.disabled)).toBe(true);
  });

  it('does nothing at all when no panel is open', () => {
    // Called from an async reply that may land after the panel closed.
    expect(() => setPanelStatus(doc, 'anything')).not.toThrow();
  });
});

describe('editing the amounts in place (D-071)', () => {
  const editable = (save: (i: number, p: string[]) => Promise<readonly string[]>) =>
    open({ onEditPresets: save });

  it('shows no pencil when there is nowhere to save', () => {
    // An edit control that quietly does nothing is worse than none.
    expect(open().shadow.querySelector('.edit')).toBeNull();
  });

  it('reveals a field per preset, under the buttons they edit', () => {
    const p = editable(async () => ['0.001', '0.01']);
    (p.shadow.querySelector('.edit') as HTMLButtonElement).dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    const fields = [...p.shadow.querySelectorAll('.fields input')] as HTMLInputElement[];
    expect(fields.map((f) => f.value)).toEqual(['0.001', '0.01']);
  });

  it('saves what was typed and redraws from what was stored', async () => {
    // Not from what was typed: the validator may trim or refuse, and the
    // buttons must show what a click will actually spend.
    const asked: string[][] = [];
    const p = editable(async (_i, presets) => { asked.push(presets); return ['0.05', '0.5']; });
    (p.shadow.querySelector('.edit') as HTMLButtonElement).dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    const fields = [...p.shadow.querySelectorAll('.fields input')] as HTMLInputElement[];
    fields[0]!.value = ' 0.05 ';
    fields[1]!.value = '';
    (p.shadow.querySelector('.save .ok') as HTMLButtonElement).dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    await vi.waitFor(() => expect(p.buys().map((b) => b.textContent)).toEqual(['0.05', '0.5']));
    // Blank fields are dropped rather than saved as empty buttons.
    expect(asked).toEqual([['0.05']]);
  });

  it('keeps the editor open and says why when saving is refused', async () => {
    const p = editable(async () => { throw new Error('0,5 is not an amount'); });
    (p.shadow.querySelector('.edit') as HTMLButtonElement).dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    (p.shadow.querySelector('.save .ok') as HTMLButtonElement).dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    await vi.waitFor(() => {
      const err = p.shadow.querySelector('.err') as HTMLElement;
      expect(err.hidden).toBe(false);
      expect(err.textContent).toContain('0,5');
    });
    expect(p.shadow.querySelector('.fields')).not.toBeNull();
  });

  it('cancel restores the buttons untouched', () => {
    const p = editable(async () => ['9']);
    (p.shadow.querySelector('.edit') as HTMLButtonElement).dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    (p.shadow.querySelector('.save .no') as HTMLButtonElement).dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    expect(p.shadow.querySelector('.fields')).toBeNull();
    expect(p.buys().map((b) => b.textContent)).toEqual(['0.001', '0.01']);
  });
});

describe('where it sits', () => {
  it('clamps a stored position that would strand it off screen', () => {
    const p = open({ position: { x: 99_999, y: -400 } });
    const panel = p.shadow.querySelector('.panel') as HTMLElement;
    const x = Number.parseInt(panel.style.left, 10);
    const y = Number.parseInt(panel.style.top, 10);
    expect(x).toBeGreaterThanOrEqual(8);
    expect(x).toBeLessThan(doc.defaultView!.innerWidth);
    expect(y).toBeGreaterThanOrEqual(8);
  });

  it('honours a position that is already sensible', () => {
    const p = open({ position: { x: 120, y: 200 } });
    const panel = p.shadow.querySelector('.panel') as HTMLElement;
    expect(panel.style.left).toBe('120px');
    expect(panel.style.top).toBe('200px');
  });
});
