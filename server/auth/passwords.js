import argon2 from 'argon2';
import { normalizePassword } from './validate.js';

// Argon2id is the OWASP-recommended password hash. Parameters meet OWASP's minimum (19 MiB, t=2, p=1)
// and are configurable. The salt is random and stored inside the hash string.
export function createPasswords({ memoryCost = 19456, timeCost = 2, parallelism = 1 } = {}) {
  const opts = { type: argon2.argon2id, memoryCost, timeCost, parallelism };
  let dummy;
  return {
    hash: (pw) => argon2.hash(normalizePassword(pw), opts),
    async verify(hash, pw) {
      try { return await argon2.verify(hash, normalizePassword(pw)); } catch { return false; }
    },
    needsRehash: (hash) => argon2.needsRehash(hash, opts),
    /** Burn the same CPU time when the account does not exist, so response time does not reveal it. */
    async fakeVerify(pw) {
      dummy ||= await argon2.hash('investbrick-timing-equaliser', opts);
      await this.verify(dummy, pw);
    },
  };
}
