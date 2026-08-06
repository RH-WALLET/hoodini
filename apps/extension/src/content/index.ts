/**
 * Content script.
 *
 * Runs in the page's world, so it is the least trusted part of the extension
 * and holds correspondingly little: it finds tokens, draws controls, and sends
 * intents. It has no key, builds no calldata, and cannot sign or spend — the
 * service worker refuses `trade.execute` from a page outright (D-026).
 */

import {
  AdapterRuntime,
  AxiomAdapter,
  ConfigurableSiteAdapter,
  GenericAddressAdapter,
  createGmgnAdapter,
  createSiteAdapters,
  createTerminalAdapter,
  matchesSite,
  mountPanel,
  unmountPanel,
  pageToken,
  pageTokenAddress,
  setPanelStatus,
  unmountAll,
  type IntentResult,
  type OverlayIntent,
  type PanelPosition,
} from '@hoodini/adapters';
import { parseEther, type Address } from 'viem';
import { DEFAULT_SETTINGS, normaliseSettings, type Settings, type TokenRef } from '@hoodini/core';

const CHAIN_ID = 4663;

/**
 * Bumped whenever the content script changes in a way a stale tab would hide.
 * Read from the page with `document.documentElement.dataset.hoodiniBuild`.
 */
const BUILD_MARKER = 'panel-7';
const DEFAULT_BUY_WEI = 10n ** 15n; // 0.001 ETH

/**
 * Live settings.
 *
 * Held in a mutable local rather than read per click: a quote must price what
 * the button says, and the button was drawn from whatever the settings were at
 * mount time. Re-reading at click time could quote a slippage the user changed
 * after the overlay was drawn.
 *
 * Starts at the defaults so the overlay works before the worker answers — a
 * cold service worker takes a moment to spin up, and a card that renders with
 * no buttons for that moment would look broken.
 */
let settings: Settings = DEFAULT_SETTINGS;

/**
 * Ask the worker to price a trade.
 *
 * Quoting is the only capability a page has. `trade.execute` is deliberately
 * unreachable from here until a confirm sheet exists, so a click currently
 * surfaces a price rather than spending anything.
 */
async function quote(intent: OverlayIntent): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'trade.quote',
      side: intent.side,
      token: intent.token.address,
      // The preset the user pressed. Until the control was seen working every
      // button emitted the same intent, so `0.01` quoted 0.001 — the presets
      // were decoration. Falls back only when an adapter emits no amount.
      amount: (intent.amount ? parseEther(intent.amount) : DEFAULT_BUY_WEI).toString(),
      slippageBps: settings.slippageBps,
    });
    // Nothing is rendered from this yet — the confirm sheet lands with the
    // execute path. Surfacing it in the console keeps the round trip
    // observable without inventing UI that would imply trading works.
    console.debug('[hoodini] quote', intent.side, intent.token.address, res);
  } catch (e) {
    // A quote failing is the user pressing a button and getting nothing, so it
    // is visible by default; the successful case above stays quiet.
    console.warn('[hoodini] quote failed', e);
  }
}

/**
 * Ask the worker whether this token can actually be sold right now.
 *
 * Omitting `amount` quotes the whole balance, because sell availability is
 * size-dependent — a curve can pay out a small amount and revert on a large
 * one — so probing a nominal amount would report a sell that then fails
 * (D-049).
 *
 * Returns null when the sell can proceed, or a reason when it cannot.
 */
async function probeSell(token: TokenRef, percent?: number): Promise<{ reason: string } | null> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'trade.quote',
      side: 'sell',
      token: token.address,
      // Prices the exact fraction this button would sell. A venue that pays out
      // a quarter can still revert on the whole balance (D-049), so probing a
      // nominal size would gate the button on a question nobody asked.
      ...(percent !== undefined ? { percent } : {}),
      slippageBps: settings.slippageBps,
    })) as { ok: boolean; error?: { code: string; message: string } } | undefined;

    if (!res) return { reason: 'the extension did not respond' };
    if (res.ok) return null;
    if (res.error?.code === 'LOCKED') return { reason: 'unlock Hoodini to sell' };
    if (res.error?.code === 'NO_BALANCE') return { reason: 'you hold none of this token' };
    return { reason: res.error?.message ?? 'this token cannot be sold right now' };
  } catch {
    // Rethrow-as-null would claim the sell is fine; instead let the overlay
    // treat a broken probe as inconclusive and re-enable.
    throw new Error('could not reach the extension');
  }
}

/**
 * A click proposes a trade; it does not start one.
 *
 * The page can only ever cause a prompt — approval happens in extension UI,
 * which this script cannot reach (D-054). So the honest thing to show on the
 * button is that the ball is now in the popup's court, not a price.
 *
 * Sells propose too. An earlier version returned here after merely quoting,
 * reasoning that the Sell control's own probe had already priced the balance
 * and that proposing again would ask the worker the same question twice. It
 * would not: the probe decides whether to *offer* the control, and the request
 * is what the user actually approves. The effect was that pressing Sell logged
 * a price at console.debug and reported success, so the sell path could not
 * reach the popup at all — found by trying to sell, never by a test (D-052,
 * D-061).
 */
async function propose(intent: OverlayIntent): Promise<IntentResult> {
  const isBuy = intent.side === 'buy' && intent.amount !== undefined;
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'trade.request',
      side: intent.side,
      token: intent.token.address,
      // Omitted entirely on a sell. The worker reads the balance itself and
      // takes the requested fraction of it; sending `0` would be an explicit
      // amount, and an explicit zero is refused rather than meaning everything.
      ...(isBuy ? { amount: parseEther(intent.amount!).toString() } : {}),
      ...(!isBuy && intent.percent !== undefined ? { percent: intent.percent } : {}),
      slippageBps: settings.slippageBps,
    })) as
      | { ok: boolean; data?: { autoApproved?: boolean }; error?: { code: string; message: string } }
      | undefined;

    if (!res) return { ok: false, message: 'no reply' };
    // Standing consent is armed, so this already ran (D-059). Saying "confirm"
    // would send the user to a popup with nothing in it, and worse, would hide
    // the fact that money just moved.
    if (res.ok && res.data?.autoApproved) return { ok: true, message: 'sent ✓' };
    if (res.ok) return { ok: true, message: 'confirm ↗' };
    // The one refusal worth naming: it means a proposal is already waiting and
    // the user has to answer that one first (D-054).
    if (res.error?.code === 'PENDING_EXISTS') return { ok: false, message: 'one pending' };
    console.warn('[hoodini] request refused', res.error);
    return { ok: false, message: 'refused' };
  } catch (e) {
    console.warn('[hoodini] request failed', e);
    return { ok: false, message: 'failed' };
  }
}

/**
 * Spend the pointer's travel time resolving the venue.
 *
 * Cold, `resolve()` costs a round trip per adapter and dominates the click —
 * measured at 1,233ms against 456ms for everything else put together. Warm it
 * costs nothing. A hover lands a few hundred milliseconds before the click, so
 * by the time the button is pressed the expensive half is already done.
 *
 * Fire-and-forget on purpose: the overlay must not wait on this, and a hover
 * that fails to warm simply means the click pays what it always paid. Deliberately
 * *not* on mount — D-049 settled that a column of fifty rows must not fire
 * fifty requests nobody asked for, and hover is the signal that one of them is
 * about to matter.
 */
function warm(token: TokenRef): void {
  void chrome.runtime.sendMessage({ type: 'trade.warm', token: token.address }).catch(() => {
    // Nothing is broken if warming fails; the click still works, just slower.
  });
}

const onIntent = (intent: OverlayIntent) => propose(intent);

/**
 * Where the panel was last dragged to.
 *
 * Kept in extension storage rather than the page's, because the page's belongs
 * to the site and a panel that moved itself between terminals would be strange.
 * Two integers, clamped into view on read, so nothing worse than a bad position
 * can come back out of it.
 */
const PANEL_POS_KEY = 'hoodini.panelpos.v1';

async function readPanelPosition(): Promise<PanelPosition | undefined> {
  try {
    const got = await chrome.storage.local.get(PANEL_POS_KEY);
    const raw = got[PANEL_POS_KEY] as { x?: unknown; y?: unknown } | undefined;
    if (typeof raw?.x !== 'number' || typeof raw?.y !== 'number') return undefined;
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return undefined;
    return { x: raw.x, y: raw.y };
  } catch {
    return undefined;
  }
}

/**
 * The coin the panel is currently pointed at, lowercased. Null when none is.
 *
 * Distinct from `panelKey`: on a feed the panel can be open over five addresses
 * with none of them picked, and the chain gate's answer belongs to whichever
 * one is picked rather than to the panel as a whole.
 */
let panelToken: string | null = null;

/**
 * Identity of what the panel is showing — one address, or the whole candidate
 * set on a page with several.
 *
 * Tracked so a rescan does not tear the panel down and rebuild it underneath
 * the user mid-drag, or reset the profile tab they just chose. It has to be the
 * *set* rather than the chosen coin, because a feed gains and loses addresses
 * as it scrolls and the list has to follow.
 */
let panelKey: string | null = null;

/**
 * A page-state whose panel the user closed.
 *
 * Without this, the next scan reopens what was just dismissed — and scans run
 * on every mutation, so the panel would come straight back. Cleared when the
 * page moves on, because dismissing one panel says nothing about the next.
 */
let dismissed: string | null = null;

/**
 * Show the panel when the page is about one token, and only then.
 *
 * A list gets the small row controls and nothing else — that is what makes them
 * usable while scanning. A coin's own page is where a panel earns its space
 * (D-067). Terminals are single-page apps, so this is re-evaluated on every
 * scan rather than once at load: navigating from Pulse into a coin never
 * reloads the document.
 */
/**
 * Network gas, for the panel's stat rows.
 *
 * `chain.stats` is popup-only, so this asks the worker rather than the explorer
 * directly — the content script has no business holding a network origin, and
 * the figure carries no address either way.
 */
async function readGas(): Promise<number | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'chain.stats' })) as
      | { ok?: boolean; data?: { gasGwei?: number | null } }
      | undefined;
    return res?.ok ? (res.data?.gasGwei ?? null) : null;
  } catch {
    return null;
  }
}

/** Nominal probe size: this asks whether a venue exists, not what a trade costs. */
const PROBE_WEI = 1_000_000_000_000_000n;

/** The address currently being asked about, so a scan burst asks once. */
let deciding: string | null = null;

/**
 * The token a *panel-only* page is about, when the route will not say.
 *
 * A post has no URL to read: X and Telegram address a conversation, never a
 * coin, so `pageTokenAddress` answers null on every social page and the panel
 * would never open. What a post does have is a subject — one address in one
 * message is the token being talked about.
 *
 * Deliberately **not** general. D-067 rejected "the page mentions exactly one
 * address" as the site-wide rule and the reason still stands: a terminal list
 * with one row loaded, or a coin page with a holders table, both satisfy it and
 * both open a trading panel on the wrong coin. The premise only holds where the
 * page is a stream of posts rather than a table of coins, which is exactly the
 * set of sites that decline to decorate.
 *
 * The chain gate is untouched by this. `ConfigurableSiteAdapter` reads addresses
 * out of text and has no chain concept, so the token arrives ungated — and
 * `pageToken` still answers null here, which is what sends the caller down the
 * probe path where the panel states the chain before it offers anything (D-069).
 */
function panelOnlyToken(detected: readonly TokenRef[]): Address | null {
  if (!(adapter instanceof ConfigurableSiteAdapter && adapter.panelOnly)) return null;
  return detected.length === 1 ? detected[0]!.address : null;
}

/**
 * Every token a panel-only page is showing.
 *
 * On a terminal this is empty: the route names the coin, and "what else is on
 * the page" is a holders table or a sidebar of related cards (D-067). On a feed
 * or a chat there is no route to read and any number of posts, so the whole set
 * goes to the panel and the user says which one they meant (D-077).
 */
function panelCandidates(detected: readonly TokenRef[]): readonly TokenRef[] {
  if (!(adapter instanceof ConfigurableSiteAdapter && adapter.panelOnly)) return [];
  return detected;
}

/** Identity of what the panel is showing, so a rescan can tell if it changed. */
const keyOf = (tokens: readonly TokenRef[]): string =>
  tokens.map((t) => t.address.toLowerCase()).sort().join(',');

/**
 * Ask whether this coin trades on Robinhood Chain, and say so in the panel.
 *
 * On a multi-chain terminal the honest answer is often no — an EVM address on a
 * coin page can be a BNB or Ethereum token — and on a post it is the only thing
 * that can answer the question at all, because a tweet never says which chain
 * it means (D-069, D-074).
 */
function probeChain(address: Address): void {
  const key = address.toLowerCase();
  deciding = key;
  void chrome.runtime
    .sendMessage({
      type: 'trade.quote',
      side: 'buy',
      token: address,
      amount: PROBE_WEI.toString(),
      slippageBps: settings.slippageBps,
    })
    .then((res: { ok?: boolean; error?: { code?: string; message?: string } } | undefined) => {
      if (deciding !== key) return;
      deciding = null;
      /**
       * The panel may have moved on — a route change, or the user picking
       * another coin out of the list. Compared against what the panel is
       * *showing*, not against the route.
       *
       * This was a route comparison, and on a social page `pageTokenAddress`
       * answers null by definition — so every answer was discarded and the
       * chain gate silently never appeared on X or Telegram. Shipped in P15 and
       * found while wiring the picker; the panel opened correctly and then said
       * nothing, which is the exact failure D-069 exists to prevent.
       */
      if (panelToken !== key) return;
      if (res?.ok) return setPanelStatus(document, null);
      setPanelStatus(
        document,
        res?.error?.code === 'UNSUPPORTED_VENUE'
          ? 'No Robinhood Chain venue trades this token. It is probably on another chain.'
          : `Cannot price this token right now${res?.error?.message ? `: ${res.error.message}` : ''}.`,
      );
    })
    .catch(() => {
      if (deciding === key) deciding = null;
      setPanelStatus(document, 'Could not reach the extension. Try reloading the page.');
    });
}

function syncPanel(detected: readonly TokenRef[]): void {
  const routeAddress = pageTokenAddress(location.href);
  const candidates = routeAddress ? [] : panelCandidates(detected);

  // A route that names a coin wins outright. Otherwise a single candidate is
  // the subject of the page, and several means the page is ambiguous — which is
  // a thing to show rather than a reason to disappear (D-077).
  const only = candidates.length === 1 ? candidates[0]!.address : null;
  const address = routeAddress ?? only;

  // Every branch below says what it decided. A panel that silently does not
  // appear is indistinguishable from one that is broken, and this project has
  // now spent three rounds on exactly that confusion (D-052).
  if (!address && candidates.length === 0) {
    if (panelKey !== null) {
      console.warn('[hoodini] panel closed: this page names no token');
      unmountPanel(document);
      panelKey = null;
      panelToken = null;
    }
    return;
  }

  const key = address ? address.toLowerCase() : keyOf(candidates);
  if (key === panelKey || key === dismissed) return;

  /**
   * A pick survives a rescan.
   *
   * Feeds mutate constantly, so the candidate set changes whenever a post
   * loads and the panel has to be rebuilt around the new list. Carrying the
   * chosen coin across means somebody who picked one does not lose it because
   * a stranger posted an address — but only while it is still on the page,
   * since a panel pointed at a coin the page no longer shows would be pointing
   * at nothing anybody can see.
   */
  const stillThere = candidates.find((c) => c.address.toLowerCase() === panelToken) ?? null;
  const known = routeAddress ? pageToken(location.href, detected) : null;
  const opening: TokenRef | null = address
    ? (known ?? { address, chainId: CHAIN_ID })
    : stillThere;

  dismissed = null;
  panelKey = key;
  panelToken = opening?.address.toLowerCase() ?? null;
  openPanel(opening, candidates);

  // Nothing picked yet, so there is nothing to ask the chain about.
  if (!opening) return;
  // The adapter already found it through its own chain gate (D-050), so the
  // question is already answered and nothing is outstanding.
  if (known) return;
  probeChain(opening.address);
}


/**
 * Open the focused panel on a token.
 *
 * The profiles come from settings, which a page may read (D-053) but never
 * write. Switching tabs inside the panel therefore changes what this page draws
 * and submits, and nothing else: it does not persist, and it cannot reach the
 * popup or another tab.
 */
/** Wallet names and which is active. Names only — never addresses (D-073). */
async function readWallets(): Promise<{ names: string[]; activeIndex: number } | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'wallet.brief' })) as
      | { ok?: boolean; data?: { names?: string[]; activeIndex?: number } }
      | undefined;
    const names = res?.data?.names;
    if (!res?.ok || !Array.isArray(names) || names.length === 0) return null;
    return { names, activeIndex: res.data?.activeIndex ?? 0 };
  } catch {
    return null;
  }
}

function openPanel(token: TokenRef | null, candidates: readonly TokenRef[] = []): void {
  void Promise.all([readPanelPosition(), readGas(), readWallets()]).then(([position, gasGwei, wallets]) => {
    const host = mountPanel(document, token, {
      profiles: settings.profiles,
      activeProfile: settings.activeProfile,
      onIntent,
      probeSell,
      ...(candidates.length > 1 ? { candidates } : {}),
      /**
       * A ticker, from the contract rather than from the post.
       *
       * The panel draws this beside a buy button. A page saying "$USDC" next to
       * an address that is a different token entirely is the substitution the
       * per-row chain gates exist to stop, and a scraped ticker would help it
       * along (D-050, D-076).
       */
      meta: async (t) => {
        const res = (await chrome.runtime.sendMessage({ type: 'token.meta', token: t.address })) as
          | { ok?: boolean; data?: { symbol?: string | null } }
          | undefined;
        return res?.ok ? { symbol: res.data?.symbol ?? null } : null;
      },
      // Picking a coin is picking what the buttons spend on, so the chain gate
      // has to be re-run for it — the previous answer was about another token.
      onSelect: (t) => {
        panelToken = t.address.toLowerCase();
        dismissed = null;
        probeChain(t.address);
      },
      // The panel is a surface you opened on purpose, so it can afford the
      // graded sells the row strip cannot (D-068).
      sellPercents: [10, 25, 50, 75, 90, 100],
      ...(gasGwei != null ? { gasGwei } : {}),
      ...(position ? { position } : {}),
      /**
       * Save edited amounts. Reaches only the active profile's buy presets —
       * slippage is not editable from a page, because it is the one setting a
       * site could widen without anyone seeing it change (D-071).
       */
      ...(wallets ? { wallets } : {}),
      onSelectWallet: async (index) => {
        await chrome.runtime.sendMessage({ type: 'wallet.selectFromPage', index });
        // Switching disarms standing consent by design (D-073), so the badge
        // and the popup have to hear about it.
        console.warn('[hoodini] wallet switched from the page — auto-approve is now off');
      },
      onEditPresets: async (_profileIndex, buyPresets) => {
        const res = (await chrome.runtime.sendMessage({ type: 'settings.setPresets', buyPresets })) as
          | { ok: boolean; data?: Settings; error?: { message?: string } }
          | undefined;
        if (!res?.ok || !res.data) throw new Error(res?.error?.message ?? 'could not save');
        // Adopted locally too, so the row strips on this page redraw with the
        // same amounts the panel now shows.
        settings = res.data;
        runtime.scan();
        return res.data.buyPresets;
      },
      onMove: (next) => {
        void chrome.storage.local.set({ [PANEL_POS_KEY]: next }).catch(() => {
          // A position that fails to save costs a drag next time, nothing more.
        });
      },
      onClose: () => {
        // Remembered against the page-state, not the coin: on a feed the panel
        // is dismissed as a whole, and keying it to whichever coin happened to
        // be picked would let the next scan reopen it under another one.
        dismissed = panelKey;
        panelKey = null;
        panelToken = null;
      },
    });
    // Reported so "it never opened" and "it opened somewhere I cannot see" are
    // different sentences in the log rather than the same silence.
    const box = host.shadowRoot?.querySelector('.panel')?.getBoundingClientRect();
    console.warn('[hoodini] panel mounted at', box ? `${Math.round(box.x)},${Math.round(box.y)}` : 'unknown', box);
  });
}

// Prefer the adapter that knows this site; fall back to shape-based detection
// so an unlisted page still gets controls rather than nothing.
//
// The three terminals come first, and the order matters: each gates on chain,
// and the generic fallback does not. On a multi-chain terminal the generic
// adapter would decorate BNB, Ethereum and Solana rows as though they were
// Robinhood Chain (D-050), so it must never be what handles them.
const adapterOptions = {
  chainId: CHAIN_ID,
  onIntent,
  probeSell,
  onWarm: warm,
  // A getter, not a snapshot: the adapter is built once at load, before the
  // worker has answered, so a copied array would pin the overlay to the
  // defaults for the life of the page.
  get amounts(): readonly string[] {
    return settings.buyPresets;
  },
  // Also a getter: the slippage shown under the buttons has to be the slippage
  // that will actually be submitted, including after the user edits it.
  get config(): { slippageBps: number } {
    return { slippageBps: settings.slippageBps };
  },
};
const adapter =
  [
    new AxiomAdapter(adapterOptions),
    createGmgnAdapter(adapterOptions),
    createTerminalAdapter(adapterOptions),
    ...createSiteAdapters(adapterOptions),
  ].find((a) => matchesSite(a, location.href)) ?? new GenericAddressAdapter(adapterOptions);

const runtime = new AdapterRuntime(adapter, document, {
  // `warn`, not `debug`. A scan error means the overlay is not working, and
  // Chrome hides `debug` unless Verbose is switched on — so the one channel
  // that says what went wrong was invisible by default. That cost three rounds
  // of guessing before the first real bug was found (D-052).
  onError: (e) => console.warn('[hoodini] scan error', e),
  onScan: syncPanel,
});

/**
 * Stamp the document with what is running.
 *
 * Content scripts inject on page load and never again: reloading the extension
 * leaves every open tab running the previous build, which has now cost this
 * project two debugging sessions that both ended in "hard-reload the tab"
 * (D-052, D-067). A marker turns "is the new code even here?" from a guess into
 * a one-line answer.
 *
 * On documentElement rather than a global, because a content script's globals
 * are isolated from the page and therefore invisible to a console paste.
 */
document.documentElement.setAttribute('data-hoodini-build', BUILD_MARKER);
document.documentElement.setAttribute('data-hoodini-panel-capable', 'yes');

runtime.start();

/**
 * Adopt the user's settings once the worker answers, and again whenever they
 * change.
 *
 * `unmountAll` then a rescan, rather than trying to patch each control in
 * place: the presets decide how many buttons exist and what each one spends, so
 * a partial update risks a button whose label and amount disagree — which is
 * the exact class of bug this feature was added to fix.
 */
async function adoptSettings(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'settings.get' })) as
      | { ok: boolean; data?: unknown }
      | undefined;
    if (!res?.ok) return;
    const next = normaliseSettings(res.data);
    if (next.buyPresets.join() === settings.buyPresets.join() && next.slippageBps === settings.slippageBps) {
      return;
    }
    settings = next;
    unmountAll(document);
    runtime.scan();
  } catch {
    // The worker being asleep or gone is not a reason to tear down the overlay.
  }
}

void adoptSettings();

// The popup broadcasts after a save; storage is the fallback for a save made
// while this tab was in another window.
chrome.runtime.onMessage.addListener((m: { type?: string }) => {
  if (m?.type === 'settings.changed') void adoptSettings();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['hoodini.settings.v1']) void adoptSettings();
});

// The page owns its lifecycle; leave it exactly as found on the way out.
addEventListener('pagehide', () => runtime.stop(), { once: true });
