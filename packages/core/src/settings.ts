/**
 * User settings: buy presets and slippage.
 *
 * Pure and offline. Nothing here reads storage or talks to a browser — that is
 * the extension's job — because these values decide how much of the user's
 * money a button spends, and validating them is exactly the kind of logic that
 * should be testable without a DOM.
 *
 * ## Why this is not "just a form"
 *
 * A preset is a spend amount. It arrives from a text input, survives in
 * storage, and is later turned into wei and put in a transaction. So it is
 * treated as untrusted input at the point it enters, not at the point it is
 * used: `normaliseSettings` accepts anything at all and always returns a
 * usable, bounded result. Corrupted storage, a hand-edited value, a field left
 * blank — each degrades to the default rather than producing a trade nobody
 * intended.
 *
 * The alternative — validating at the call site — puts the check somewhere it
 * can be forgotten, and this project has already found one bug of exactly that
 * shape (the presets that never reached the intent at all).
 */

/**
 * One configuration: what the buttons spend, and how much slippage they accept.
 *
 * Slippage belongs *inside* a profile rather than beside them. The reference
 * terminals get this right: the reason to keep three of these is that market
 * conditions differ, and a calm-market preset set with a hot-market slippage is
 * not a configuration anyone wanted (D-066).
 */
export interface Profile {
  /** Quick-buy amounts in ETH, in the order they are shown. */
  readonly buyPresets: readonly string[];
  /** Slippage tolerance in basis points. 100 = 1%. */
  readonly slippageBps: number;
}

export interface Settings {
  /** Exactly `PROFILE_COUNT` of them, addressed as P1, P2, P3 in the UI. */
  readonly profiles: readonly Profile[];
  /** Which one is in force. Always a valid index into `profiles`. */
  readonly activeProfile: number;
  /**
   * The active profile's presets, flattened.
   *
   * Not redundant — load-bearing. Every existing reader (the overlay, the
   * content script, the confirm sheet) asks for `buyPresets` and must keep
   * working without knowing profiles exist. Kept in step by
   * `normaliseSettings`, which is the only thing that constructs a `Settings`.
   */
  readonly buyPresets: readonly string[];
  /** The active profile's slippage, flattened. See `buyPresets`. */
  readonly slippageBps: number;
}

/** P1, P2, P3. Three is what the reference uses and what fits a row of tabs. */
export const PROFILE_COUNT = 3;

/**
 * Three profiles that differ in the way market conditions do.
 *
 * P1 is the everyday one and matches what the extension shipped with before
 * profiles existed, so an upgrade changes nothing anyone had set. P2 is bigger
 * with more slippage for a fast market; P3 is a size nobody presses by accident.
 */
const DEFAULT_PROFILES: readonly Profile[] = [
  { buyPresets: ['0.001', '0.01'], slippageBps: 100 },
  { buyPresets: ['0.01', '0.05', '0.1'], slippageBps: 300 },
  { buyPresets: ['0.1', '0.25'], slippageBps: 500 },
];

export const DEFAULT_SETTINGS: Settings = {
  profiles: DEFAULT_PROFILES,
  activeProfile: 0,
  buyPresets: DEFAULT_PROFILES[0]!.buyPresets,
  slippageBps: DEFAULT_PROFILES[0]!.slippageBps,
};

/** At least one button, and few enough to fit a terminal card. */
export const MIN_PRESETS = 1;
export const MAX_PRESETS = 6;

/**
 * Sell fractions a profile may carry, most-used first.
 *
 * Six, matching the buy side. The row strip still shows two — it decorates
 * somebody else's card and has no room — while the panel shows the lot (D-072).
 */
export const DEFAULT_SELL_PERCENTS: readonly number[] = [10, 25, 50, 75, 90, 100];

/**
 * Bounds on a single preset, in ETH.
 *
 * The ceiling is not a safety mechanism — the engine's canary limit and the
 * `LIVE_TRADING` build flag are, and they sit at the send boundary where they
 * cannot be bypassed. This only stops a typo like `100` becoming a button the
 * user might press by accident.
 */
export const MIN_PRESET_ETH = 0.000001;
export const MAX_PRESET_ETH = 10;

/** 0.01% to 50%. Above that a "swap" is a donation. */
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 5000;

/**
 * Is this a preset a user could have meant?
 *
 * Rejects anything `parseEther` would mangle or reject later: exponent
 * notation, hex, whitespace-only, signs, more than 18 decimals. Accepting them
 * here would move the failure to the moment of spending.
 */
export function isValidPreset(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!/^\d*\.?\d+$/.test(s)) return false;
  const decimals = s.split('.')[1]?.length ?? 0;
  if (decimals > 18) return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= MIN_PRESET_ETH && n <= MAX_PRESET_ETH;
}

export function isValidSlippageBps(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SLIPPAGE_BPS &&
    value <= MAX_SLIPPAGE_BPS
  );
}

/**
 * Coerce anything into usable settings.
 *
 * Total by design: every input produces a valid `Settings`. Invalid presets are
 * dropped individually rather than failing the whole record, so one bad row in
 * storage does not cost the user the other three.
 */
function normaliseProfile(input: unknown, fallback: Profile): Profile {
  const raw = (input ?? {}) as Partial<Record<keyof Profile, unknown>>;

  const presets = Array.isArray(raw.buyPresets)
    ? raw.buyPresets.filter(isValidPreset).map((p) => p.trim())
    : [];

  // Deduplicated by value, not by string: '0.10' and '0.1' are one button.
  const seen = new Set<number>();
  const unique: string[] = [];
  for (const p of presets) {
    const n = Number(p);
    if (seen.has(n)) continue;
    seen.add(n);
    unique.push(p);
    if (unique.length >= MAX_PRESETS) break;
  }

  return {
    buyPresets: unique.length >= MIN_PRESETS ? unique : fallback.buyPresets,
    slippageBps: isValidSlippageBps(raw.slippageBps) ? raw.slippageBps : fallback.slippageBps,
  };
}

export function normaliseSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Record<string, unknown>;

  // Storage written before profiles existed is a single flat configuration.
  // Read as P1 rather than discarded, so upgrading does not silently reset
  // amounts somebody had chosen.
  const source: unknown[] = Array.isArray(raw['profiles'])
    ? (raw['profiles'] as unknown[])
    : [raw];

  const profiles = Array.from({ length: PROFILE_COUNT }, (_, i) =>
    normaliseProfile(source[i], DEFAULT_PROFILES[i]!),
  );

  const wanted = raw['activeProfile'];
  const active =
    typeof wanted === 'number' && Number.isInteger(wanted) && wanted >= 0 && wanted < PROFILE_COUNT
      ? wanted
      : 0;

  // The flattened fields are derived here and nowhere else, so they cannot
  // drift from the profile they are supposed to mirror.
  const chosen = profiles[active]!;
  return { profiles, activeProfile: active, buyPresets: chosen.buyPresets, slippageBps: chosen.slippageBps };
}

/**
 * Validate a settings edit, with a reason the user can act on.
 *
 * Separate from `normaliseSettings` on purpose. Saving must never silently
 * discard what someone typed — if a value is wrong they need telling, not
 * quietly replacing with a default. Normalisation is for reading, this is for
 * writing.
 */
export type SettingsError = { readonly field: 'buyPresets' | 'slippageBps'; readonly message: string };

export function validateSettings(input: unknown): SettingsError | null {
  const outer = (input ?? {}) as Record<string, unknown>;

  // A full record: every profile must be valid, because saving one that is not
  // would leave a tab the user can select and then cannot spend from.
  if (Array.isArray(outer['profiles'])) {
    const list = outer['profiles'] as unknown[];
    if (list.length !== PROFILE_COUNT) {
      return { field: 'buyPresets', message: `expected ${PROFILE_COUNT} profiles` };
    }
    for (let i = 0; i < list.length; i++) {
      const err = validateProfile(list[i]);
      // Named by tab, so an error points at the one that is wrong rather than
      // at "settings".
      if (err) return { ...err, message: `P${i + 1}: ${err.message}` };
    }
    const active = outer['activeProfile'];
    if (
      active !== undefined &&
      (typeof active !== 'number' || !Number.isInteger(active) || active < 0 || active >= PROFILE_COUNT)
    ) {
      return { field: 'buyPresets', message: 'that profile does not exist' };
    }
    return null;
  }

  return validateProfile(input);
}

function validateProfile(input: unknown): SettingsError | null {
  const raw = (input ?? {}) as Partial<Record<keyof Profile, unknown>>;

  if (!Array.isArray(raw.buyPresets)) {
    return { field: 'buyPresets', message: 'presets must be a list' };
  }
  if (raw.buyPresets.length < MIN_PRESETS) {
    return { field: 'buyPresets', message: 'add at least one buy amount' };
  }
  if (raw.buyPresets.length > MAX_PRESETS) {
    return { field: 'buyPresets', message: `at most ${MAX_PRESETS} buy amounts` };
  }
  for (const p of raw.buyPresets) {
    if (!isValidPreset(p)) {
      return {
        field: 'buyPresets',
        message: `"${String(p)}" is not an amount between ${MIN_PRESET_ETH} and ${MAX_PRESET_ETH} ETH`,
      };
    }
  }
  const values = raw.buyPresets.map(Number);
  if (new Set(values).size !== values.length) {
    return { field: 'buyPresets', message: 'each amount must be different' };
  }
  if (!isValidSlippageBps(raw.slippageBps)) {
    return {
      field: 'slippageBps',
      message: `slippage must be a whole number of basis points between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS}`,
    };
  }
  return null;
}
