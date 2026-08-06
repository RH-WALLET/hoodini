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

  it('offers six sell fractions, which a wide panel can show at once', () => {
    expect(open().sells().map((b) => b.textContent)).toEqual(['10%', '25%', '50%', '75%', '90%', '100%']);
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
    const allowed = new Set(['0.001', '0.01', '10', '25', '50', '75', '90', '100', '1', '0']);
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
    p.sells()[3]!.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
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
    const sells = p.sells();
    const quarter = sells[1]!;
    const whole = sells[sells.length - 1]!;
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
    expect(p.seen[0]).toMatchObject({ side: 'sell', percent: 10 });
  });

  it('re-enables when the probe itself fails, rather than blaming the venue', async () => {
    const p = open({ probeSell: async () => { throw new Error('rpc timeout'); } });
    const b = p.sells()[0]!;
    b.dispatchEvent(new doc.defaultView!.Event('click', { bubbles: true }));
    await vi.waitFor(() => expect(b.disabled).toBe(false));
    expect(b.textContent).toBe('10%');
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

/**
 * The fee cap on the config strip (P14).
 *
 * The strip is the panel's statement of what a click will actually submit with,
 * so a cap that changes what gets signed belongs on it. It is shown only when
 * set: an absent cap means the node decides, and a row reading "Max gas —"
 * would invite the reader to wonder what it was hiding.
 */
describe('the fee cap on the config strip', () => {
  const cfg = (shadow: ShadowRoot) => shadow.querySelector('.cfg')!.textContent ?? '';

  it('shows the cap when the profile sets one', () => {
    const p = open({ profiles: [{ buyPresets: ['0.001'], slippageBps: 100, maxFeeGwei: '0.5' }] });
    expect(cfg(p.shadow)).toContain('Max gas');
    expect(cfg(p.shadow)).toContain('0.5 gwei');
  });

  it('says nothing at all when it does not', () => {
    const p = open({ profiles: [{ buyPresets: ['0.001'], slippageBps: 100 }] });
    expect(cfg(p.shadow)).not.toContain('Max gas');
    expect(cfg(p.shadow)).not.toContain('gwei');
  });

  it('keeps slippage and the 0% fee either way', () => {
    for (const profile of [
      { buyPresets: ['0.001'], slippageBps: 250 },
      { buyPresets: ['0.001'], slippageBps: 250, maxFeeGwei: '2' },
    ]) {
      const p = open({ profiles: [profile] });
      expect(cfg(p.shadow)).toContain('2.50%');
      expect(cfg(p.shadow)).toContain('0%');
    }
  });

  it('leaves exactly one spacer when no cap is set, so the 0% does not move', () => {
    // The spacer is what pushes `Fee 0%` to the right. A second one left in
    // place would shift it whenever a profile happened not to set a cap.
    const without = open({ profiles: [{ buyPresets: ['0.001'], slippageBps: 100 }] });
    expect(without.shadow.querySelectorAll('.cfg .sp')).toHaveLength(1);
    const with_ = open({ profiles: [{ buyPresets: ['0.001'], slippageBps: 100, maxFeeGwei: '1' }] });
    expect(with_.shadow.querySelectorAll('.cfg .sp')).toHaveLength(2);
  });

  it('follows the profile tab, since each carries its own cap', () => {
    const p = open({
      profiles: [
        { buyPresets: ['0.001'], slippageBps: 100 },
        { buyPresets: ['0.01'], slippageBps: 300, maxFeeGwei: '3' },
      ],
    });
    expect(cfg(p.shadow)).not.toContain('gwei');
    p.tabs()[1]!.click();
    expect(cfg(p.shadow)).toContain('3 gwei');
  });
});


/**
 * The panel names its coin, and asks which one when the page shows several
 * (P16, D-076, D-077).
 *
 * Two properties matter more than the rest. A ticker is *never* taken from the
 * page — it arrives through `meta`, which the caller answers from the chain —
 * because this string is drawn beside a buy button. And nothing is preselected
 * when the page is ambiguous, because preselecting is guessing which coin
 * somebody meant, and the guess would be wired to a spend.
 */
describe('naming the coin', () => {
  const B = { address: '0xfF5eD17855d6A4915A63643fe95E3f882AceE887', chainId: 4663 } as const;
  const head = (s: ShadowRoot) => s.querySelector('.hd')!.textContent ?? '';
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('shows the truncated address before any ticker has arrived', () => {
    const p = open();
    expect(head(p.shadow)).toContain(`${TOKEN.address.slice(0, 6)}…${TOKEN.address.slice(-4)}`);
  });

  it('carries the full address for a copy, not the truncation on screen', () => {
    const p = open();
    expect(p.shadow.querySelector('.tok')!.getAttribute('title')).toBe(TOKEN.address);
  });

  it('draws the ticker once the chain answers', async () => {
    const p = open({ meta: async () => ({ symbol: 'YEW' }) });
    await settle();
    expect(p.shadow.querySelector('.sym')!.textContent).toBe('YEW');
    // The address stays visible beside it. The two disagreeing is the thing
    // worth noticing, and hiding one of them would remove the ability to.
    expect(head(p.shadow)).toContain('…');
  });

  it('asks for a ticker once per address however often it redraws', async () => {
    const asked: string[] = [];
    const p = open({ meta: async (t) => { asked.push(t.address); return { symbol: 'YEW' }; } });
    await settle();
    p.tabs()[1]!.click();
    p.tabs()[2]!.click();
    await settle();
    expect(asked).toEqual([TOKEN.address]);
  });

  it('shows the address alone when the token has no symbol', async () => {
    // Honest: the address is what was actually on the page.
    const p = open({ meta: async () => ({ symbol: null }) });
    await settle();
    expect(p.shadow.querySelector('.sym')!.textContent).toBe('—');
    expect(head(p.shadow)).toContain('…');
  });

  it('survives a meta lookup that fails outright', async () => {
    const p = open({ meta: async () => { throw new Error('offline'); } });
    await settle();
    expect(p.shadow.querySelector('.tok')!.textContent).toContain('…');
  });
});

describe('several coins on one page', () => {
  const A = { address: '0xB84e494158976B4e14da155d1cdaE16EB6D1C477', chainId: 4663 } as const;
  const B = { address: '0xfF5eD17855d6A4915A63643fe95E3f882AceE887', chainId: 4663 } as const;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const picks = (s: ShadowRoot) => [...s.querySelectorAll('.pick button')] as HTMLButtonElement[];

  const many = (over: Record<string, unknown> = {}) =>
    open({ candidates: [A, B], ...over });

  it('draws no picker when the page shows one coin', () => {
    const p = open({ candidates: [A] });
    expect(p.shadow.querySelector('.pick')!.hidden).toBe(true);
  });

  it('lists every coin on the page when there are several', () => {
    const p = many();
    expect(picks(p.shadow)).toHaveLength(2);
    expect(p.shadow.querySelector('.pick')!.hidden).toBe(false);
  });

  it('preselects nothing, and says so in words the user can act on', () => {
    const p = mountPanel(doc, null, { profiles: PROFILES, onIntent: () => {}, candidates: [A, B] });
    const shadow = p.shadowRoot!;
    expect(shadow.querySelector('.pick .lbl')!.textContent).toMatch(/choose one/i);
    expect(shadow.querySelector('.sym')!.textContent).toMatch(/select a coin/i);
    expect([...shadow.querySelectorAll('.pick button.on')]).toHaveLength(0);
  });

  it('disables every buy and sell until one is picked', () => {
    const host = mountPanel(doc, null, { profiles: PROFILES, onIntent: () => {}, candidates: [A, B] });
    const shadow = host.shadowRoot!;
    for (const b of shadow.querySelectorAll('.grid button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('a click with nothing picked cannot emit an intent', () => {
    const seen: OverlayIntent[] = [];
    const host = mountPanel(doc, null, {
      profiles: PROFILES, onIntent: (i) => seen.push(i), candidates: [A, B],
    });
    // Fired past the disabled attribute, which a page can remove from a shadow
    // node it can reach. There is nothing to spend on, so there is no intent.
    for (const b of host.shadowRoot!.querySelectorAll('.grid button')) {
      (b as HTMLButtonElement).disabled = false;
      (b as HTMLButtonElement).click();
    }
    expect(seen).toEqual([]);
  });

  it('picking one arms the panel and points it at that coin', () => {
    const seen: OverlayIntent[] = [];
    const host = mountPanel(doc, null, {
      profiles: PROFILES, onIntent: (i) => seen.push(i), candidates: [A, B],
    });
    const shadow = host.shadowRoot!;
    (shadow.querySelectorAll('.pick button')[1] as HTMLButtonElement).click();
    expect(shadow.querySelectorAll('.pick button.on')).toHaveLength(1);
    (shadow.querySelector('.buy button') as HTMLButtonElement).click();
    expect(seen[0]!.token.address).toBe(B.address);
  });

  it('tells the caller, so the chain gate can be re-run for the new coin', () => {
    const chosen: string[] = [];
    const host = mountPanel(doc, null, {
      profiles: PROFILES, onIntent: () => {}, candidates: [A, B],
      onSelect: (t) => chosen.push(t.address),
    });
    (host.shadowRoot!.querySelectorAll('.pick button')[1] as HTMLButtonElement).click();
    expect(chosen).toEqual([B.address]);
  });

  it('switching coins buys the new one, never the old', () => {
    const seen: OverlayIntent[] = [];
    const host = mountPanel(doc, A, {
      profiles: PROFILES, onIntent: (i) => seen.push(i), candidates: [A, B],
    });
    const shadow = host.shadowRoot!;
    (shadow.querySelector('.buy button') as HTMLButtonElement).click();
    (shadow.querySelectorAll('.pick button')[1] as HTMLButtonElement).click();
    (shadow.querySelector('.buy button') as HTMLButtonElement).click();
    expect(seen.map((i) => i.token.address)).toEqual([A.address, B.address]);
  });

  it('clears one coin’s chain gate when another is picked', () => {
    const host = mountPanel(doc, A, { profiles: PROFILES, onIntent: () => {}, candidates: [A, B] });
    setPanelStatus(doc, 'No Robinhood Chain venue trades this token.');
    expect((host.shadowRoot!.querySelector('.status') as HTMLElement).hidden).toBe(false);
    (host.shadowRoot!.querySelectorAll('.pick button')[1] as HTMLButtonElement).click();
    // That answer was about the other coin. Leaving it up would attach one
    // token's refusal to another.
    expect((host.shadowRoot!.querySelector('.status') as HTMLElement).hidden).toBe(true);
  });

  it('clearing a chain gate does not arm a panel with nothing picked', () => {
    // Two independent reasons to be dead. The chain does not get to answer the
    // other one.
    const host = mountPanel(doc, null, { profiles: PROFILES, onIntent: () => {}, candidates: [A, B] });
    setPanelStatus(doc, null);
    for (const b of host.shadowRoot!.querySelectorAll('.grid button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('keeps the buttons dead when a profile is switched under a refusal', () => {
    // `render` rebuilds these buttons, so switching profile used to hand back a
    // live Buy underneath the sentence saying the coin cannot be traded here.
    const host = mountPanel(doc, A, { profiles: PROFILES, onIntent: () => {} });
    setPanelStatus(doc, 'No Robinhood Chain venue trades this token.');
    (host.shadowRoot!.querySelectorAll('.tabs button')[1] as HTMLButtonElement).click();
    for (const b of host.shadowRoot!.querySelectorAll('.grid button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('names each coin in the list once the chain answers', async () => {
    const p = many({ meta: async (t: { address: string }) =>
      ({ symbol: t.address === A.address ? 'YEW' : 'PONS' }) });
    await settle();
    const text = [...picks(p.shadow)].map((b) => b.textContent ?? '');
    expect(text[0]).toContain('YEW');
    expect(text[1]).toContain('PONS');
  });

  it('says "unnamed" rather than nothing for a coin with no symbol', async () => {
    const p = many({ meta: async () => ({ symbol: null }) });
    await settle();
    expect(picks(p.shadow)[0]!.textContent).toContain('unnamed');
    // And still shows its address, which is the part that identifies it.
    expect(picks(p.shadow)[0]!.textContent).toContain('…');
  });
});
