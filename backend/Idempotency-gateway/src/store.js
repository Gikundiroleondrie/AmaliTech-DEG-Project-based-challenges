'use strict';

class IdempotencyStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.sweeper = null;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.status === 'completed' && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  begin(key, fingerprint) {
    const entry = { fingerprint, status: 'processing', response: null, expiresAt: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.promise.catch(() => {});
    this.entries.set(key, entry);
    return entry;
  }

  complete(key, entry, response) {
    entry.status = 'completed';
    entry.response = response;
    entry.expiresAt = Date.now() + this.ttlMs;
    entry.resolve(response);
  }

  fail(key, entry, error) {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    entry.reject(error);
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.status === 'completed' && entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  startSweeper(intervalMs = 60_000) {
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref();
  }

  stopSweeper() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { IdempotencyStore };
