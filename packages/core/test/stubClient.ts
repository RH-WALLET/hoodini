/**
 * A stub PublicClient.
 *
 * Tests here must never touch the network: a suite that depends on live pool
 * state would go red when a token dumps, which is exactly what happened to
 * Kolana between two reads (D-016-amendment). Chain reality is the harness's
 * job; this file exists so the encoding can be pinned deterministically.
 */

import type { Address, PublicClient } from 'viem';

export interface StubBehaviour {
  /** `${address.toLowerCase()}.${functionName}` -> value (or a thrower). */
  readonly reads?: Record<string, unknown>;
  /** `${address.toLowerCase()}.${functionName}` -> simulate result. */
  readonly simulates?: Record<string, unknown>;
  readonly chainId?: number;
}

export interface StubClient {
  readonly client: PublicClient;
  /** Every read the code under test performed, in order. */
  readonly calls: string[];
}

class NotStubbedError extends Error {
  constructor(key: string) {
    super(`stub: no value for ${key}`);
  }
}

export function createStubClient(behaviour: StubBehaviour): StubClient {
  const calls: string[] = [];

  const key = (address: Address, functionName: string) => `${address.toLowerCase()}.${functionName}`;

  const client = {
    async getChainId() {
      return behaviour.chainId ?? 4663;
    },
    async readContract({ address, functionName }: { address: Address; functionName: string }) {
      const k = key(address, functionName);
      calls.push(k);
      if (!behaviour.reads || !(k in behaviour.reads)) throw new NotStubbedError(k);
      const v = behaviour.reads[k];
      if (v instanceof Error) throw v;
      return v;
    },
    async simulateContract({ address, functionName }: { address: Address; functionName: string }) {
      const k = key(address, functionName);
      calls.push(k);
      if (!behaviour.simulates || !(k in behaviour.simulates)) throw new NotStubbedError(k);
      const v = behaviour.simulates[k];
      if (v instanceof Error) throw v;
      return { result: v };
    },
  } as unknown as PublicClient;

  return { client, calls };
}
