/**
 * Folding the settings form back into a full settings record.
 *
 * Extracted from the component for the same reason `notice.ts` was: it is a
 * small pure function with a consequence out of proportion to its size. It
 * decides what is written to storage, and what is written to storage is what a
 * button later spends and what a transaction is later signed with.
 *
 * The specific hazard is that the edited profile is **rebuilt, not spread
 * over**. That is deliberate — a spread would carry through whatever happened
 * to be in storage, including a value the validator would now reject — but it
 * means every field a `Profile` has must be named here. A field left out is
 * silently dropped by any save that did not touch it.
 *
 * D-071 found exactly that shape once already, when saving wrote into the
 * caller's array and one test's save appeared in the next test's assertions.
 * The fee cap is the second field to pass through here, and it is the reason
 * this function now has tests of its own rather than only being exercised
 * through the UI.
 */

import type { Settings } from '@hoodini/core';

export interface ProfileEdit {
  readonly buyPresets: readonly string[];
  /** Raw from the input. Non-numeric becomes NaN, which the validator refuses. */
  readonly slippageBps: string;
  /** Raw from the input. Blank means "no cap" — how the cap is switched off. */
  readonly maxFeeGwei: string;
}

export function withEdits(base: Settings, index: number, edit: ProfileEdit): Settings {
  const bps = edit.slippageBps.trim();
  const cap = edit.maxFeeGwei.trim();

  const profiles = base.profiles.map((p, i) =>
    i === index
      ? {
          buyPresets: edit.buyPresets.map((v) => v.trim()).filter((v) => v !== ''),
          // NaN rather than 0 on a non-numeric input: 0 is a number the
          // validator would have to special-case, NaN is plainly not a value.
          slippageBps: /^\d+$/.test(bps) ? Number(bps) : Number.NaN,
          // Absent rather than an empty string, so clearing the field reaches
          // storage as "no cap" instead of as a blank sitting where a number
          // should be.
          ...(cap !== '' ? { maxFeeGwei: cap } : {}),
        }
      : p,
  );

  return { ...base, profiles, activeProfile: index };
}
