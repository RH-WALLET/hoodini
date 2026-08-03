/**
 * AdapterRuntime — drives a SiteAdapter against a live, changing page.
 *
 * Terminals are SPAs with virtualised lists: rows mount, unmount, and get
 * *recycled* for different tokens several times a second. So a runtime that
 * scanned once would decorate nothing after the first render, and one that
 * scanned on every mutation would burn the main thread.
 *
 * This batches mutations, coalesces them into one scan per frame-ish window,
 * and relies on the adapter's `mount` being idempotent.
 */

import type { TokenRef } from '@hoodini/core';
import type { SiteAdapter } from './site.js';

export interface RuntimeOptions {
  /** Quiet period after a mutation burst before rescanning. */
  readonly debounceMs?: number;
  /** Injected for tests; defaults to the real timers. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly observe?: (target: Node, cb: () => void) => { disconnect: () => void };
  /** Reports scan errors instead of letting one bad row kill the runtime. */
  readonly onError?: (error: unknown) => void;
}

export class AdapterRuntime {
  readonly #adapter: SiteAdapter;
  readonly #doc: Document;
  readonly #debounceMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #observeFn: ((target: Node, cb: () => void) => { disconnect: () => void }) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;

  #observer: { disconnect: () => void } | null = null;
  #pending: unknown = null;
  #scans = 0;

  constructor(adapter: SiteAdapter, doc: Document, options: RuntimeOptions = {}) {
    this.#adapter = adapter;
    this.#doc = doc;
    this.#debounceMs = options.debounceMs ?? 150;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#observeFn = options.observe;
    this.#onError = options.onError;
  }

  /** Scans performed. Exposed so tests can assert coalescing actually happens. */
  get scanCount(): number {
    return this.#scans;
  }

  start(): void {
    this.scan();
    const observe =
      this.#observeFn ??
      ((target: Node, cb: () => void) => {
        const mo = new MutationObserver(cb);
        mo.observe(target, { childList: true, subtree: true, characterData: true });
        return mo;
      });
    this.#observer = observe(this.#doc.body ?? this.#doc, () => this.#schedule());
  }

  stop(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#pending !== null) {
      this.#clearTimer(this.#pending);
      this.#pending = null;
    }
  }

  /** Collapse a burst of mutations into one scan. */
  #schedule(): void {
    if (this.#pending !== null) this.#clearTimer(this.#pending);
    this.#pending = this.#setTimer(() => {
      this.#pending = null;
      this.scan();
    }, this.#debounceMs);
  }

  /**
   * One pass: detect tokens, find anchors, mount.
   *
   * Our own mounts mutate the DOM, which would retrigger the observer. That is
   * harmless because `mount` is idempotent — the follow-up scan finds nothing to
   * change and settles — but the debounce is what keeps it from being a busy
   * loop.
   */
  scan(): number {
    this.#scans++;
    let mounted = 0;
    let tokens: TokenRef[] = [];

    try {
      tokens = this.#adapter.detectTokens(this.#doc);
    } catch (e) {
      this.#onError?.(e);
      return 0;
    }

    for (const token of tokens) {
      try {
        for (const anchor of this.#adapter.findAnchors(token)) {
          this.#adapter.mount(anchor, token);
          mounted++;
        }
      } catch (e) {
        // One malformed row must not stop the rest of the page being decorated.
        this.#onError?.(e);
      }
    }
    return mounted;
  }
}

/**
 * Does this adapter own the current URL?
 *
 * Checked in the content script even though the manifest already restricts
 * where it runs: an SPA can navigate to a path the adapter does not handle
 * without the script ever being reloaded.
 */
export function matchesSite(adapter: SiteAdapter, url: string): boolean {
  try {
    return adapter.siteMatch.test(url);
  } catch {
    return false;
  }
}
