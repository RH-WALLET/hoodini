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

export interface Settings {
  /** Quick-buy amounts in ETH, in the order they are shown. */
  readonly buyPresets: readonly string[];
  /** Slippage tolerance in basis points. 100 = 1%. */
  readonly slippageBps: number;
}

export const DEFAULT_SETTINGS: Settings = {
  buyPresets: ['0.001', '0.01'],
  slippageBps: 100,
};

/** At least one button, and few enough to fit a terminal card. */
export const MIN_PRESETS = 1;
export const MAX_PRESETS = 4;

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
export function normaliseSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Record<keyof Settings, unknown>>;

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
    buyPresets: unique.length >= MIN_PRESETS ? unique : DEFAULT_SETTINGS.buyPresets,
    slippageBps: isValidSlippageBps(raw.slippageBps) ? raw.slippageBps : DEFAULT_SETTINGS.slippageBps,
  };
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
  const raw = (input ?? {}) as Partial<Record<keyof Settings, unknown>>;

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
