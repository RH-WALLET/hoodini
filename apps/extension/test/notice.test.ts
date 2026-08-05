/**
 * The one sentence that has to be right.
 *
 * The confirm sheet's notice is the difference between "this rehearses" and
 * "this spends", shown directly above the button that does it. The first
 * version was a hardcoded string claiming the build could not broadcast — true
 * in a dry-run build, a lie in a live one, and it survived until the moment
 * someone was about to make a real trade.
 *
 * So it is a pure function now, and these are its tests.
 */

import { describe, expect, it } from 'vitest';
import { confirmNotice } from '../src/popup/notice.js';
import { CANARY_MAX_WEI } from '../src/background/engine.js';

describe('confirmNotice', () => {
  it('says a dry-run build cannot broadcast', () => {
    const n = confirmNotice(false, CANARY_MAX_WEI);
    expect(n.tone).toBe('info');
    expect(n.text).toMatch(/cannot broadcast/i);
    expect(n.text).toMatch(/simulates/i);
  });

  it('says a live build spends, and that it cannot be undone', () => {
    const n = confirmNotice(true, CANARY_MAX_WEI);
    expect(n.tone).toBe('danger');
    expect(n.text).toMatch(/\bLIVE\b/);
    expect(n.text).toMatch(/real transaction/i);
    expect(n.text).toMatch(/cannot be undone/i);
  });

  it('never tells a live build it is safe', () => {
    // The failure that matters is one specific direction: claiming a live
    // build simulates. Asserted as its own case so it cannot be lost in a
    // rewrite of the wording.
    const n = confirmNotice(true, CANARY_MAX_WEI);
    expect(n.text).not.toMatch(/cannot broadcast/i);
    expect(n.text).not.toMatch(/simulat/i);
  });

  it('never tells a dry-run build it will spend', () => {
    const n = confirmNotice(false, CANARY_MAX_WEI);
    expect(n.text).not.toMatch(/real transaction/i);
    expect(n.tone).not.toBe('danger');
  });

  it('quotes the ceiling the engine will actually enforce', () => {
    // 5e15 wei. If the sheet and the engine ever disagree, the sheet is
    // promising a limit that is not the one refusing the trade.
    expect(confirmNotice(true, CANARY_MAX_WEI).text).toContain('0.005');
    expect(CANARY_MAX_WEI).toBe(5_000_000_000_000_000n);
  });

  it('formats a whole-number ceiling without a stray point', () => {
    expect(confirmNotice(true, 1n * 10n ** 18n).text).toContain('1 ETH');
  });
});
