'use strict';

/**
 * In-memory idempotency store.
 *
 * Each entry looks like:
 *   { fingerprint, status: 'processing' | 'completed', promise, response, expiresAt }
 *
 * Node runs JS on a single thread, so the "check then claim" sequence in the
 * request handler (no `await` between get() and begin()) is atomic. That is
 * what prevents two simultaneous requests from both starting to process.
 */
class IdempotencyStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.sweeper = null;
  }

  /** Returns the live entry for a key, lazily evicting it if its TTL passed. */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.status === 'completed' && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Claim a key: mark it "processing" and expose a promise other requests can await. */
  begin(key, fingerprint) {
    const entry = { fingerprint, status: 'processing', response: null, expiresAt: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    // Waiters handle rejection themselves; this avoids unhandled-rejection noise
    // if nobody happens to be waiting.
    entry.promise.catch(() => {});
    this.entries.set(key, entry);
    return entry;
  }

  /** Save the final response and wake up every request waiting on this key. */
  complete(key, entry, response) {
    entry.status = 'completed';
    entry.response = response;
    entry.expiresAt = Date.now() + this.ttlMs;
    entry.resolve(response);
  }

  /** Processing failed: forget the key so the client may retry, and release waiters. */
  fail(key, entry, error) {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    entry.reject(error);
  }

  /** Remove all expired entries (called periodically). */
  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.status === 'completed' && entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  startSweeper(intervalMs = 60_000) {
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref(); // never keep the process alive just for cleanup
  }

  stopSweeper() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { IdempotencyStore };
