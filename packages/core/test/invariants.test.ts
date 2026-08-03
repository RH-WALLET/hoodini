/**
 * Executable checks on the invariants in CLAUDE.md that code could silently
 * violate later. A comment saying "never add a fee" is not enforcement; a
 * failing test is.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, type Address } from 'viem';
import * as abis from '../src/abis.js';
import * as core from '../src/index.js';
import { PONS_FACTORIES, SWAP_ROUTER_02, VENUE_REGISTRY, WETH, QUOTER_V2, NOXA_FACTORY, UNISWAP_V3_FACTORY } from '../src/venues/registry.js';
import { UniswapV3Adapter } from '../src/venues/uniswapV3.js';
import { createStubClient } from './stubClient.js';

const TOKEN = getAddress('0xB84e494158976B4e14da155d1cdaE16EB6D1C477');
const POOL = getAddress('0xac2e451a6b141a0b2b2d9fd746fff4724491db5e');
const PONS = PONS_FACTORIES[0] as Address;

describe('invariant 6 — 0% platform fee', () => {
  it('declares no fee-taking router function', () => {
    // The DEPLOYED router really does expose sweepTokenWithFee and
    // unwrapWETH9WithFee. Both take feeBips + feeRecipient, which is exactly
    // the skim the invariant forbids. Keeping them out of our ABI makes
    // calling one a type error rather than a silent one-line change.
    const names = abis.SWAP_ROUTER_02_ABI.map((e) => e.name);
    expect(names).not.toContain('sweepTokenWithFee');
    expect(names).not.toContain('unwrapWETH9WithFee');
    expect(names.some((n) => /fee/i.test(n))).toBe(false);
  });

  it('has no fee parameter anywhere in the router ABI beyond the pool fee tier', () => {
    const feeInputs = abis.SWAP_ROUTER_02_ABI.flatMap((e) =>
      (e.inputs ?? []).flatMap((i) =>
        'components' in i && i.components ? i.components.map((c) => c.name) : [i.name],
      ),
    ).filter((n): n is string => typeof n === 'string' && /fee/i.test(n));
    // `fee` is the Uniswap pool tier and belongs to the pool, not to us.
    expect(feeInputs).toEqual(['fee']);
    expect(feeInputs).not.toContain('feeBips');
    expect(feeInputs).not.toContain('feeRecipient');
  });

  it('builds calldata that pays out only to the signer', async () => {
    const { client } = createStubClient({
      reads: {
        [`${TOKEN.toLowerCase()}.liquidityPool`]: POOL,
        [`${TOKEN.toLowerCase()}.poolFee`]: 10_000,
        [`${TOKEN.toLowerCase()}.launchFactory`]: PONS,
        [`${POOL.toLowerCase()}.liquidity`]: 1n,
        [`${PONS.toLowerCase()}.graduationStatus`]: [1n, 1n, true],
      },
      simulates: { [`${QUOTER_V2.toLowerCase()}.quoteExactInputSingle`]: [1000n, 0n, 0, 1n] },
    });
    const adapter = new UniswapV3Adapter(client);
    const token = { address: TOKEN, chainId: 4663 };

    const buy = await adapter.buildBuy(token, 10n ** 15n, 100);
    const sell = await adapter.buildSell(token, 10n ** 15n, 100);

    // No address other than the router, the traded token, WETH and the two
    // sentinels may appear in built calldata. A fee recipient would have to
    // show up here as a 20-byte word, so this catches one being smuggled in.
    const allowed = new Set(
      [SWAP_ROUTER_02, TOKEN, WETH, '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']
        .map((a) => a.toLowerCase().slice(2)),
    );
    for (const tx of [buy, sell]) {
      const words = (tx.data.slice(2).match(/.{64}/g) ?? [])
        .filter((w) => w.startsWith('000000000000000000000000') && !/^0{64}$/.test(w))
        .map((w) => w.slice(24));
      for (const w of words) expect(allowed).toContain(w);
    }
  });

  it('never exports a broadcast path from core', () => {
    // Custody is core's job; *sending* is not. Key handling lives here on
    // purpose — what must never appear is anything that puts a transaction on
    // the wire, since that is the boundary LIVE_TRADING guards.
    const exported = Object.keys(core);
    expect(exported.filter((k) => /sendTransaction|sendRaw|broadcast|writeContract|walletClient/i.test(k))).toEqual([]);
  });

  it('exposes exactly the intended key-touching surface', () => {
    // A new export that touches keys should be a deliberate edit to this list,
    // not something that appears silently alongside a feature.
    //
    // "key" is matched broadly on purpose, so Uniswap V4's *pool* keys land
    // here too. They are pool identity, not key material — listed explicitly
    // rather than filtered out, so the tripwire stays tight.
    const keyTouching = Object.keys(core).filter((k) => /key|vault|keystore|password/i.test(k)).sort();
    expect(keyTouching).toEqual(
      [
        'KeystoreError',
        'KeystoreSession',
        'changePassword',
        'createRandomVault',
        'createVault',
        'exportPrivateKey',
        'generatePrivateKey',
        'unlockVault',
        // Uniswap V4 pool identity — nothing to do with private keys.
        'klikPoolKey',
      ].sort(),
    );
  });
});

describe('invariant 1 — keys never leave the device', () => {
  // The strongest available static check: the keystore must contain no way to
  // put bytes on the network. Reading the source is crude but it is exactly
  // the property being claimed, and it fails loudly if anyone adds a fetch.
  const keystoreDir = resolve(fileURLToPath(import.meta.url), '../../src/keystore');
  // Strip comments first. The invariant is about what the code DOES; the
  // prose necessarily mentions chrome.storage and networking to explain why
  // they are absent, and matching that would be a false positive.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const sources = readdirSync(keystoreDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: stripComments(readFileSync(resolve(keystoreDir, f), 'utf8')) }));

  it('has source files to check', () => {
    expect(sources.length).toBeGreaterThanOrEqual(3);
  });

  it.each(['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'import(', 'eval('])(
    'contains no %s anywhere in the keystore',
    (needle) => {
      const offenders = sources.filter((s) => s.text.includes(needle)).map((s) => s.file);
      expect(offenders).toEqual([]);
    },
  );

  it('never writes a key to storage itself — persistence is the caller\'s decision', () => {
    const offenders = sources.filter((s) => /chrome\.storage|localStorage|sessionStorage|indexedDB/.test(s.text));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it('never logs from the keystore', () => {
    // A stray console.log of a decrypted value would put a key in the devtools
    // buffer, which outlives the session.
    const offenders = sources.filter((s) => /console\.(log|info|warn|error|debug)/.test(s.text));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });
});

describe('invariant 3 — bundled registry, no remote config', () => {
  it('every registry address is a checksummed literal', () => {
    for (const entry of VENUE_REGISTRY) {
      for (const addr of [entry.dexFactory, entry.router, entry.quoter, ...(entry.factories ?? [])]) {
        if (!addr) continue;
        expect(isAddress(addr)).toBe(true);
        expect(addr).toBe(getAddress(addr));
      }
    }
  });

  it('only VERIFIED entries are present (D-010)', () => {
    expect(VENUE_REGISTRY.every((e) => e.status === 'VERIFIED')).toBe(true);
  });

  it('lists no duplicate factories', () => {
    const all = VENUE_REGISTRY.flatMap((e) => e.factories ?? []).map((a) => a.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });

  it('pins the infrastructure addresses the census verified', () => {
    // Guards against a careless edit repointing trades at another contract.
    expect(WETH).toBe(getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'));
    expect(UNISWAP_V3_FACTORY).toBe(getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'));
    expect(SWAP_ROUTER_02).toBe(getAddress('0xCaf681a66D020601342297493863E78C959E5cb2'));
    expect(QUOTER_V2).toBe(getAddress('0x238ECf693467381E6402AD7d7833880FfeA33D88'));
  });

  it('covers all nine Pons-family factories plus NOXA (D-013)', () => {
    expect(PONS_FACTORIES).toHaveLength(9);
    const uniswap = VENUE_REGISTRY.find((e) => e.id === 'uniswap-v3');
    expect(uniswap?.factories).toContain(NOXA_FACTORY);
    for (const f of PONS_FACTORIES) expect(uniswap?.factories).toContain(f);
  });
});
