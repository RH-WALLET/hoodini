/**
 * What the confirm sheet says about whether approving will spend.
 *
 * Extracted from the component so it can be tested without a DOM, because it is
 * the single most consequential sentence in the interface: it is the difference
 * between "this rehearses" and "this spends", shown at the exact moment someone
 * is deciding whether to click.
 *
 * It got that treatment because the first version was a hardcoded string saying
 * the build could not broadcast. In a dry-run build that was true. In the live
 * build it would have been a lie, displayed directly above the button that
 * spends — found while preparing the first live trade, which is close enough to
 * too late.
 */

export interface ConfirmNotice {
  readonly tone: 'info' | 'danger';
  readonly text: string;
}

/**
 * @param liveTrading the build constant, not a runtime setting — a page, the
 * popup and corrupted storage all have no say in it (invariant 5).
 * @param maxSendWei the engine's hard ceiling, quoted so the number the user
 * reads is the number the engine will actually enforce.
 */
export function confirmNotice(liveTrading: boolean, maxSendWei: bigint): ConfirmNotice {
  if (!liveTrading) {
    return {
      tone: 'info',
      text: 'This build cannot broadcast. Approving simulates the trade against live chain state and reports what would have happened.',
    };
  }
  const eth = formatEthShort(maxSendWei);
  return {
    tone: 'danger',
    text: `LIVE. Approving will sign and broadcast a real transaction from this wallet, and it cannot be undone. The engine refuses any plan above ${eth} ETH.`,
  };
}

/** Enough decimals to read a ceiling, not so many it becomes noise. */
function formatEthShort(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
