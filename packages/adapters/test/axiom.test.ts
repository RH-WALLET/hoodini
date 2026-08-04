/**
 * AxiomAdapter.
 *
 * The fixtures below mirror `docs/dom/axiom.trade.json` — the same nesting
 * depth, the same twin quick-buy buttons, the same truncated contract text with
 * the real address only in attributes, and the same chain badges. Both sample
 * addresses are the ones actually captured, including the BNB Chain token whose
 * address ends `7777` and would fool a suffix heuristic.
 *
 * The property that matters most here is not that the adapter decorates a
 * Robinhood row. It is that it refuses everything else.
 */

import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { AxiomAdapter, createAxiomAdapter } from '../src/adapters/axiom.js';
import { HOST_ATTR } from '../src/overlay.js';
import { matchesSite } from '../src/runtime.js';

/** Zaibatsu Wagies — Robinhood Chain, from the capture. */
const RH = getAddress('0x5dbaca8327b0baa57eb6c872a333bf8d6f642ba3');
/** Bullpost — BNB Chain via Flap. Note the `7777` suffix. */
const BNB = getAddress('0x05274cf4b065e8665cec084c4a41608926187777');

const CHAIN = 4663;
const opts = { chainId: CHAIN, onIntent: () => {} };

const CDN = 'https://axiom-assets-v2.axiom-cdn.io/images';

const BADGES = {
  robinhood: `<img alt="Robinhood" src="${CDN}/robinhood-logo.svg">`,
  /** Robinhood's gas token is ETH, so its denomination icon says ETH. */
  ethRobinhood: `<img alt="ETH" src="${CDN}/eth-robinhood-v2.svg">`,
  /** Ethereum mainnet — same alt, different asset. */
  ethMainnet: `<img alt="ETH" src="${CDN}/eth.svg">`,
  bnb: `<img alt="BNB" src="${CDN}/bnb-fill.svg">`,
  /** Asset renamed, alt intact — the case the alt check exists for. */
  altOnly: `<img alt="Robinhood" src="${CDN}/chains/rh-v3.svg">`,
  /** Alt dropped, asset intact — the case the filename check exists for. */
  srcOnly: `<img alt="" src="${CDN}/robinhood-logo.svg">`,
  none: '',
} as const;

const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;

/**
 * One Pulse card, at the depth the real markup uses: the token image sits eight
 * levels below the card, and the quick-buy buttons are siblings of the block
 * holding the icon and name — not inside it.
 */
function card(address: string, badge: keyof typeof BADGES, buyLabel = '0.1 ETH'): string {
  const a = address.toLowerCase();
  const quickBuy = (visibility: string) => `
    <div class="absolute z-30 ${visibility}"><div class=""><div class="  ">
      <button type="button" class="bg-primaryBlue flex flex-row gap-[4px] rounded-[999px] group/quickBuyButton">
        <span class="relative z-10 flex"><i class="ri-flashlight-fill"></i><span
          class="text-[12px] font-bold">${buyLabel}</span></span>
      </button>
    </div></div></div>`;

  return `
    <div class="relative z-[1] flex h-full w-full flex-col" data-fixture="card">
      ${quickBuy('block sm:hidden bottom-[10px] right-[12px]')}
      ${quickBuy('hidden sm:block right-[12px] bottom-[16px] lg:opacity-0 xl:opacity-100')}
      <div class="flex w-full flex-row items-center" data-fixture="block">
        <div class="flex flex-col items-center">
          <div class="relative h-[74px] w-[74px]">
            <span class="contents"><div class="absolute bottom-[-4px]"><div class="flex h-[14px]">
              ${BADGES[badge]}
              <img alt="Uniswap v4" src="${CDN}/evm/protocols/uniswap.svg">
            </div></div></span>
            <div class="absolute z-20"><div class="bg-backgroundSecondary"><div class="h-[68px]">
              <div class="group/image">
                <img alt="Token" src="https://axiomtrading-eth-v2.axiom-cdn.io/${a}.webp">
                <button type="button" class="absolute inset-0"><i class="ri-camera-line"></i></button>
              </div>
            </div></div></div>
          </div>
          <span class="contents"><span class="max-w-[74px]">
            <button type="button" class="group/copy flex"><span>${short(a)}</span></button>
          </span></span>
        </div>
        <div class="flex h-full flex-1 flex-col">
          <div class="truncate text-[16px]">TOK</div>
          <a href="https://x.com/search?q=${a}"><i class="ri-search-line"></i></a>
        </div>
      </div>
    </div>`;
}

function render(...cards: string[]): void {
  document.body.innerHTML = `<div class="pulse-column">${cards.join('')}</div>`;
}

/** Detect → anchor → mount, the way the runtime drives an adapter. */
function run(adapter: AxiomAdapter): { tokens: string[]; anchors: Element[] } {
  const anchors: Element[] = [];
  const tokens: string[] = [];
  for (const t of adapter.detectTokens(document)) {
    tokens.push(t.address);
    for (const a of adapter.findAnchors(t)) {
      adapter.mount(a, t);
      anchors.push(a);
    }
  }
  return { tokens, anchors };
}

describe('site matching', () => {
  it('claims axiom.trade and nothing that merely looks like it', () => {
    const a = createAxiomAdapter(opts);
    expect(matchesSite(a, 'https://axiom.trade/pulse?chain=sol')).toBe(true);
    expect(matchesSite(a, 'https://axiom.trade/meme/0xabc')).toBe(true);
    expect(matchesSite(a, 'https://axiom.trade.evil.example/pulse')).toBe(false);
    expect(matchesSite(a, 'https://notaxiom.trade/pulse')).toBe(false);
  });
});

describe('chain gating (D-050)', () => {
  it('decorates a Robinhood card', () => {
    render(card(RH, 'robinhood'));
    const { tokens, anchors } = run(createAxiomAdapter(opts));
    expect(tokens).toEqual([RH]);
    expect(anchors).toHaveLength(1);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });

  it('refuses a BNB card whose address ends 7777', () => {
    // The whole reason this adapter exists. Detecting by address shape would
    // offer a Robinhood Chain buy on a BNB Chain token.
    render(card(BNB, 'bnb'));
    const { tokens, anchors } = run(createAxiomAdapter(opts));
    expect(tokens).toEqual([]);
    expect(anchors).toEqual([]);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(0);
  });

  it('picks only the Robinhood row out of a mixed column', () => {
    render(card(BNB, 'bnb', '0 BNB'), card(RH, 'robinhood'));
    const { tokens, anchors } = run(createAxiomAdapter(opts));
    expect(tokens).toEqual([RH]);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.querySelector('img[alt="Robinhood"]')).not.toBeNull();
  });

  it('refuses a card with no chain badge at all', () => {
    render(card(RH, 'none'));
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([]);
  });

  it('accepts the Robinhood-specific ETH icon but not Ethereum mainnet', () => {
    // Both badges carry alt="ETH". The alt alone is not the signal; the asset
    // is. This pair is what stops `alt` being read as the chain.
    render(card(RH, 'ethRobinhood'));
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([RH]);

    render(card(RH, 'ethMainnet'));
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([]);
  });

  it('recognises the badge by alt alone, if the asset is renamed', () => {
    // Axiom already ships this icon as `-v2`; a `-v3` would break a
    // filename-only check. Proven separately from the src path (D-025).
    render(card(RH, 'altOnly'));
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([RH]);
  });

  it('recognises the badge by asset alone, if the alt is dropped', () => {
    render(card(RH, 'srcOnly'));
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([RH]);
  });

  it('does not treat the quick-buy label as a chain marker', () => {
    // A BNB card whose button happens to read ETH is still a BNB card.
    render(card(BNB, 'bnb', '0.1 ETH'));
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([]);
  });
});

describe('anchoring', () => {
  it('anchors on the card, not the icon-and-name block', () => {
    // The block has no buy control, so it is the wrong place for ours.
    render(card(RH, 'robinhood'));
    const { anchors } = run(createAxiomAdapter(opts));
    expect(anchors[0]!.getAttribute('data-fixture')).toBe('card');
  });

  it('mounts once despite two quick-buy buttons per card', () => {
    render(card(RH, 'robinhood'));
    expect(document.querySelectorAll('.group\\/quickBuyButton, [class*="quickBuyButton"]').length).toBe(2);
    run(createAxiomAdapter(opts));
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });

  it('returns one anchor though the address appears three times in the card', () => {
    render(card(RH, 'robinhood'));
    const adapter = createAxiomAdapter(opts);
    adapter.detectTokens(document);
    expect(adapter.findAnchors({ address: RH, chainId: CHAIN })).toHaveLength(1);
  });

  it('is idempotent across rescans', () => {
    render(card(RH, 'robinhood'));
    const adapter = createAxiomAdapter(opts);
    run(adapter);
    run(adapter);
    run(adapter);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });

  it('never nests a control inside one it already mounted', () => {
    render(card(RH, 'robinhood'));
    const adapter = createAxiomAdapter(opts);
    run(adapter);
    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    // Simulate the page re-rendering our host into a position where a naive
    // rescan would treat it as part of a card.
    expect(host.closest('[data-fixture="card"]')).not.toBeNull();
    run(adapter);
    expect(document.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });

  it('returns nothing before a scan has happened', () => {
    render(card(RH, 'robinhood'));
    expect(createAxiomAdapter(opts).findAnchors({ address: RH, chainId: CHAIN })).toEqual([]);
  });
});

describe('reading the address', () => {
  it('reads it from attributes, since the visible text is truncated', () => {
    render(card(RH, 'robinhood'));
    expect(document.body.textContent).toContain(short(RH.toLowerCase()));
    expect(document.body.textContent).not.toContain(RH.toLowerCase());
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([RH]);
  });

  it('finds nothing when a card carries only the truncated form', () => {
    render(
      `<div class="relative z-[1] flex flex-col" data-fixture="card">
         <button class="group/quickBuyButton">0.1 ETH</button>
         ${BADGES.robinhood}
         <span>${short(RH.toLowerCase())}</span>
       </div>`,
    );
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([]);
  });

  it('ignores an address outside any buyable card', () => {
    // The tracker panel and page chrome carry addresses too.
    render(`<div class="tracker"><a href="https://x.com/search?q=${RH.toLowerCase()}">wallet</a></div>`);
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([]);
  });

  it('does not mistake the copy-contract button for a buy control', () => {
    // Its text is an address, which contains digits. A card with only that
    // button is not a card we can anchor in.
    render(
      `<div data-fixture="card">
         ${BADGES.robinhood}
         <img src="https://axiomtrading-eth-v2.axiom-cdn.io/${RH.toLowerCase()}.webp">
         <button class="group/copy"><span>${short(RH.toLowerCase())}</span></button>
       </div>`,
    );
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([]);
  });
});

describe('buy-control recognition', () => {
  it.each([['0.1 ETH'], ['0 BNB'], ['0.15'], ['Buy'], ['0'], ['⚡ 0 ETH']])(
    'recognises %s as a quick-buy label even without the group class',
    (label) => {
      render(
        `<div data-fixture="card">
           ${BADGES.robinhood}
           <img src="https://axiomtrading-eth-v2.axiom-cdn.io/${RH.toLowerCase()}.webp">
           <button class="bg-primaryBlue">${label}</button>
         </div>`,
      );
      expect(run(createAxiomAdapter(opts)).tokens).toEqual([RH]);
    },
  );

  it('does not read a long run of digits as a price', () => {
    // A market cap inside a button matches the digit pattern; only the length
    // bound rejects it.
    render(
      `<div data-fixture="card">
         ${BADGES.robinhood}
         <img src="https://axiomtrading-eth-v2.axiom-cdn.io/${RH.toLowerCase()}.webp">
         <button class="stat">1,234,567,890,123,456,789,012</button>
       </div>`,
    );
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([]);
  });

  it('falls back to the group class when the label is unrecognisable', () => {
    render(
      `<div data-fixture="card">
         ${BADGES.robinhood}
         <img src="https://axiomtrading-eth-v2.axiom-cdn.io/${RH.toLowerCase()}.webp">
         <button class="group/quickBuyButton">Schnellkauf</button>
       </div>`,
    );
    expect(run(createAxiomAdapter(opts)).tokens).toEqual([RH]);
  });
});

describe('intents', () => {
  it('emits a buy intent carrying the token the card is for', () => {
    const seen: string[] = [];
    render(card(RH, 'robinhood'));
    run(createAxiomAdapter({ chainId: CHAIN, onIntent: (i) => seen.push(`${i.side}:${i.token.address}`) }));

    const host = document.querySelector(`[${HOST_ATTR}]`)!;
    const buy = host.shadowRoot!.querySelector('button')!;
    buy.dispatchEvent(new Event('click', { bubbles: true }));
    expect(seen).toEqual([`buy:${RH}`]);
  });
});
