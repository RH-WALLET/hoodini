/**
 * Settings validation.
 *
 * A preset is a spend amount that arrives from a text field, survives in
 * storage, and later becomes wei in a transaction. So the interesting cases
 * here are not the valid ones — they are the shapes that would otherwise reach
 * `parseEther` and either throw at the moment of trading or, worse, succeed at
 * a value nobody meant.
 */

import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import {
  DEFAULT_SETTINGS,
  MAX_PRESETS,
  isValidPreset,
  isValidSlippageBps,
  normaliseSettings,
  validateSettings,
} from '../src/settings.js';

describe('isValidPreset', () => {
  it.each(['0.001', '0.01', '1', '0.5', '10', '0.000001', '.5'])('accepts %s', (v) => {
    expect(isValidPreset(v)).toBe(true);
  });

  it.each([
    ['1e-3', 'exponent notation'],
    ['0x01', 'hex'],
    ['0,5', 'a comma decimal'],
    ['-1', 'a negative'],
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['abc', 'letters'],
    ['1.2.3', 'two points'],
    ['Infinity', 'infinity'],
    ['100', 'above the ceiling'],
    ['0.0000001', 'below the floor'],
    ['0.1234567890123456789', 'more than 18 decimals'],
  ])('rejects %s (%s)', (v) => {
    expect(isValidPreset(v)).toBe(false);
  });

  it.each([null, undefined, 0.01, {}, ['0.01']])('rejects the non-string %s', (v) => {
    expect(isValidPreset(v)).toBe(false);
  });

  it('accepts only what parseEther can actually take', () => {
    // The bound that matters: anything this says yes to must survive the
    // conversion it exists to protect.
    for (const v of ['0.001', '0.01', '1', '10', '0.000001', '.5']) {
      expect(() => parseEther(v)).not.toThrow();
    }
  });
});

describe('isValidSlippageBps', () => {
  it.each([1, 100, 500, 5000])('accepts %i', (v) => expect(isValidSlippageBps(v)).toBe(true));
  it.each([0, -1, 5001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (v) => {
    expect(isValidSlippageBps(v)).toBe(false);
  });
  it('rejects a numeric string, which would compare wrong later', () => {
    expect(isValidSlippageBps('100')).toBe(false);
  });
});

describe('normaliseSettings', () => {
  it.each([null, undefined, 42, 'nonsense', {}, []])('returns usable settings for %s', (input) => {
    expect(normaliseSettings(input)).toEqual(DEFAULT_SETTINGS);
  });

  it('drops only the invalid presets, keeping the rest', () => {
    // One corrupt row in storage must not cost the user their other buttons.
    const s = normaliseSettings({ buyPresets: ['0.01', 'oops', '0.5'], slippageBps: 250 });
    expect(s.buyPresets).toEqual(['0.01', '0.5']);
    expect(s.slippageBps).toBe(250);
  });

  it('falls back to defaults when every preset is invalid', () => {
    expect(normaliseSettings({ buyPresets: ['x', '-1'] }).buyPresets).toEqual(DEFAULT_SETTINGS.buyPresets);
  });

  it('deduplicates by value, not by spelling', () => {
    // '0.10' and '0.1' would render as two buttons that spend the same amount.
    expect(normaliseSettings({ buyPresets: ['0.1', '0.10', '0.5'] }).buyPresets).toEqual(['0.1', '0.5']);
  });

  it('caps the number of presets so the control still fits a card', () => {
    const many = ['0.001', '0.01', '0.1', '0.5', '1', '2'];
    expect(normaliseSettings({ buyPresets: many }).buyPresets).toHaveLength(MAX_PRESETS);
  });

  it('keeps a valid slippage even when the presets are rubbish', () => {
    expect(normaliseSettings({ buyPresets: 'no', slippageBps: 300 })).toEqual({
      buyPresets: DEFAULT_SETTINGS.buyPresets,
      slippageBps: 300,
    });
  });

  it('trims whitespace rather than rejecting it', () => {
    expect(normaliseSettings({ buyPresets: [' 0.02 '] }).buyPresets).toEqual(['0.02']);
  });
});

describe('validateSettings', () => {
  it('accepts a well-formed edit', () => {
    expect(validateSettings({ buyPresets: ['0.01', '0.1'], slippageBps: 150 })).toBeNull();
  });

  it('reports the offending value, so the user can see what to fix', () => {
    const err = validateSettings({ buyPresets: ['0.01', '0,5'], slippageBps: 100 });
    expect(err?.field).toBe('buyPresets');
    expect(err?.message).toContain('0,5');
  });

  it.each([
    [{ buyPresets: [], slippageBps: 100 }, 'buyPresets'],
    [{ buyPresets: ['0.01', '0.01'], slippageBps: 100 }, 'buyPresets'],
    [{ buyPresets: ['0.01', '0.02', '0.03', '0.04', '0.05'], slippageBps: 100 }, 'buyPresets'],
    [{ buyPresets: ['0.01'], slippageBps: 0 }, 'slippageBps'],
    [{ buyPresets: ['0.01'], slippageBps: 9999 }, 'slippageBps'],
    [{ buyPresets: ['0.01'], slippageBps: Number.NaN }, 'slippageBps'],
    [{ slippageBps: 100 }, 'buyPresets'],
  ])('rejects %j on %s', (input, field) => {
    expect(validateSettings(input)?.field).toBe(field);
  });

  it('rejects rather than silently repairing, unlike normalise', () => {
    // The two functions exist for different moments. Reading forgives; saving
    // must not, or a typo would be quietly replaced by a default and the user
    // would never learn their edit did not take.
    const bad = { buyPresets: ['0.01', 'nope'], slippageBps: 100 };
    expect(validateSettings(bad)).not.toBeNull();
    expect(normaliseSettings(bad).buyPresets).toEqual(['0.01']);
  });
});
