// TTL cache with single-flight (concurrent callers share one upstream request) and
// stale-while-error (serve last good value, explicitly flagged, if upstream fails).
export class Cache {
  constructor({ now = () => Date.now(), maxStaleMs = 6 * 3600e3 } = {}) {
    this.now = now; this.maxStaleMs = maxStaleMs;
    this.store = new Map(); this.inflight = new Map();
  }
  /** fetcher() -> value. Returns {value, fetchedAt, stale, error?} */
  async get(key, ttlMs, fetcher) {
    const hit = this.store.get(key);
    const t = this.now();
    if (hit && t - hit.at < ttlMs) return { value: hit.value, fetchedAt: hit.at, stale: false };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await fetcher();
        const at = this.now();
        this.store.set(key, { value, at });
        return { value, fetchedAt: at, stale: false };
      } catch (err) {
        if (hit && this.now() - hit.at < this.maxStaleMs) {
          return { value: hit.value, fetchedAt: hit.at, stale: true, error: err.message };
        }
        throw err;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

// Simple circuit breaker so a failing provider isn't hammered.
export class Breaker {
  constructor({ threshold = 3, cooldownMs = 60e3, now = () => Date.now() } = {}) {
    Object.assign(this, { threshold, cooldownMs, now, fails: 0, openUntil: 0 });
  }
  get isOpen() { return this.now() < this.openUntil; }
  ok() { this.fails = 0; this.openUntil = 0; }
  fail() { if (++this.fails >= this.threshold) this.openUntil = this.now() + this.cooldownMs; }
  /** Provider told us to back off (HTTP 429 / Retry-After): pause immediately for at least that long. */
  trip(ms) { this.fails = this.threshold; this.openUntil = Math.max(this.openUntil, this.now() + Math.max(ms || 0, this.cooldownMs)); }
}
