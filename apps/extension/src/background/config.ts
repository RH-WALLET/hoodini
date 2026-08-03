/**
 * Build-time safety flags.
 *
 * `LIVE_TRADING` is a build constant, not a runtime setting. A released build
 * therefore cannot be persuaded to broadcast by anything a page, the popup, or
 * corrupted storage says — going live requires deliberately rebuilding with
 * the flag set (CLAUDE.md invariant 5).
 *
 *   VITE_LIVE_TRADING=true pnpm --filter @hoodini/extension build
 *
 * The default is false, so an accidental release is inert.
 */
export const LIVE_TRADING: boolean = import.meta.env?.['VITE_LIVE_TRADING'] === 'true';

/** Mirrors DRY_RUN in .env.example: the inverse of LIVE_TRADING, named for humans. */
export const DRY_RUN = !LIVE_TRADING;
