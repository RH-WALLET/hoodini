/**
 * Folding the settings form back into a settings record.
 *
 * The interesting cases are all about what happens to fields the user did *not*
 * touch. The edited profile is rebuilt rather than spread over, so a field the
 * function forgets is a field that quietly disappears on the next save — and
 * one of the fields passing through here is now the gas price a transaction
 * gets signed with.
 */

import { describe, expect, it } from 'vitest';
import { normaliseSettings, type Settings } from '@hoodini/core';
import { withEdits } from '../src/popup/edits.js';

const base = (): Settings =>
  normaliseSettings({
    profiles: [
      { buyPresets: ['0.001', '0.01'], slippageBps: 100, maxFeeGwei: '0.5' },
      { buyPresets: ['0.05'], slippageBps: 300 },
      { buyPresets: ['1'], slippageBps: 900, maxFeeGwei: '3' },
    ],
    activeProfile: 0,
  });

const edit = (over: Partial<Parameters<typeof withEdits>[2]> = {}) => ({
  buyPresets: ['0.001', '0.01'],
  slippageBps: '100',
  maxFeeGwei: '0.5',
  ...over,
});

describe('withEdits', () => {
  it('writes the edited profile and leaves the other two alone', () => {
    const b = base();
    const next = withEdits(b, 1, edit({ buyPresets: ['0.2'], slippageBps: '400', maxFeeGwei: '' }));
    expect(next.profiles[1]!.buyPresets).toEqual(['0.2']);
    expect(next.profiles[1]!.slippageBps).toBe(400);
    expect(next.profiles[0]).toEqual(b.profiles[0]);
    expect(next.profiles[2]).toEqual(b.profiles[2]);
  });

  it('does not drop a cap the user never touched', () => {
    // The bug this file exists for. A save that only changed an amount used to
    // rebuild the profile from two fields, taking the fee cap with it — and the
    // next trade would then have signed at whatever the node suggested, with
    // nothing on screen having said so.
    const next = withEdits(base(), 0, edit({ buyPresets: ['0.002', '0.01'] }));
    expect(next.profiles[0]!.maxFeeGwei).toBe('0.5');
  });

  it('a cleared field switches the cap off, as an absent key', () => {
    const next = withEdits(base(), 0, edit({ maxFeeGwei: '' }));
    expect(next.profiles[0]!.maxFeeGwei).toBeUndefined();
    // Absent, not an empty string sitting where a number should be — storage
    // round-trips this, and '' is not a value `parseGwei` could ever read.
    expect('maxFeeGwei' in next.profiles[0]!).toBe(false);
  });

  it('trims, so a pasted value with spaces is still the number that was meant', () => {
    const next = withEdits(base(), 0, edit({ maxFeeGwei: '  0.25  ' }));
    expect(next.profiles[0]!.maxFeeGwei).toBe('0.25');
  });

  it('whitespace alone is a cleared field, not a cap of nothing', () => {
    expect(withEdits(base(), 0, edit({ maxFeeGwei: '   ' })).profiles[0]!.maxFeeGwei).toBeUndefined();
  });

  it('passes a bad cap through for the validator to refuse, rather than repairing it', () => {
    // Saving must never silently replace what somebody typed — they need
    // telling. `validateSettings` is what says so; this only carries it there.
    const next = withEdits(base(), 0, edit({ maxFeeGwei: '99999' }));
    expect(next.profiles[0]!.maxFeeGwei).toBe('99999');
  });

  it('a non-numeric slippage becomes NaN, which the validator refuses', () => {
    expect(withEdits(base(), 0, edit({ slippageBps: 'abc' })).profiles[0]!.slippageBps).toBeNaN();
    expect(withEdits(base(), 0, edit({ slippageBps: '' })).profiles[0]!.slippageBps).toBeNaN();
  });

  it('drops blank preset rows, which is how the Add button starts one', () => {
    const next = withEdits(base(), 0, edit({ buyPresets: ['0.001', '', '  ', '0.5'] }));
    expect(next.profiles[0]!.buyPresets).toEqual(['0.001', '0.5']);
  });

  it('makes the edited tab the active one', () => {
    expect(withEdits(base(), 2, edit()).activeProfile).toBe(2);
  });

  it('does not mutate what it was given', () => {
    // D-071: saving once wrote straight into the caller's array, so an edit
    // changed what every later panel built from that object would draw.
    const b = base();
    const before = JSON.stringify(b);
    withEdits(b, 0, edit({ buyPresets: ['9'], slippageBps: '1', maxFeeGwei: '2' }));
    expect(JSON.stringify(b)).toBe(before);
  });

  it('survives a round trip through the validator it feeds', () => {
    const next = normaliseSettings(withEdits(base(), 0, edit({ maxFeeGwei: '0.75' })));
    expect(next.profiles[0]!.maxFeeGwei).toBe('0.75');
    // And the flattened field the overlay reads follows the active profile.
    expect(next.maxFeeGwei).toBe('0.75');
  });
});
