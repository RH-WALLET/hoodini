/**
 * The worker's venue stack.
 *
 * This file exists because of a bug that was invisible for weeks: the service
 * worker was constructed without its trade dependencies, so every `trade.quote`
 * and `positions.list` answered UNAVAILABLE. The overlay drew its buttons and
 * clicking one did nothing.
 *
 * Nothing failed. The router has a legitimate "not wired up in this build"
 * branch — correct while the engine was being written — and once it was, nobody
 * went back. It surfaced only when the popup was finally opened and showed the
 * message in red.
 *
 * So the assertion that matters is not "the stack builds". It is that every
 * venue the project claims to support is actually in the worker's router,
 * because adding an adapter and forgetting to wire it is the same mistake in a
 * smaller costume.
 */

import { describe, expect, it } from 'vitest';
import { VENUE_REGISTRY } from '@hoodini/core';
import { createVenueStack } from '../src/background/venues.js';

describe('venue stack', () => {
  it('builds without touching the network', () => {
    // Construction must be side-effect free: MV3 restarts the worker
    // constantly, and a stack that dialled out on every wake would be both
    // slow and a privacy problem.
    const { client, venues, chainId } = createVenueStack();
    expect(client).toBeDefined();
    expect(chainId).toBe(4663);
    expect(venues.adapters.length).toBeGreaterThan(0);
  });

  it('registers every venue the registry claims is supported', () => {
    // The registry is what DATA_SOURCES and the README describe to a user. An
    // entry there with no adapter in the worker is a promise the product does
    // not keep.
    const wired = new Set(createVenueStack().venues.adapters.map((a) => a.id));

    // Each fixed-parameter V4 hook takes its own venue's id (D-045), so the
    // registry and the router speak the same names and no mapping is needed.
    for (const venue of VENUE_REGISTRY) {
      if (venue.status !== 'VERIFIED') continue;
      expect(wired, `venue "${venue.id}" is in the registry but not wired into the worker`).toContain(venue.id);
    }
  });

  it('gives each adapter a distinct id, so resolution is unambiguous', () => {
    const ids = createVenueStack().venues.adapters.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
