import { log } from '../logger.js';
import { newToken, hashToken } from './tokens.js';
import { normalizeEmail, validateEmail, normalizeName, validateName, validatePassword } from './validate.js';
import { resetEmail } from './mailer.js';

const DAY = 864e5;
export class AuthError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; }
}
const publicUser = (r) => ({ id: r.id, email: r.email, name: r.display_name });

export function createAuthService({ db, passwords, mailer, config, now = () => Date.now(), onUserCreated = null }) {
  const A = {
    sessionDays: 30, idleDays: 7, resetMinutes: 60, resetCooldownSec: 60, resetMaxPerHour: 3, maxFailedLogins: 10, lockMinutes: 15, touchEveryMs: 10 * 60e3,
    ...config.auth,
  };
  const at = (ms) => new Date(ms);

  // Reset emails are sent after the HTTP response is decided, never inside it. If the request waited for the email provider,
  // "account exists" (slow: a network call) and "no such account" (instant) would be told apart by response time alone.
  const pendingMail = new Set();
  function sendInBackground(message) {
    const p = Promise.resolve().then(() => mailer.send(message))
      .catch((e) => log.error('password reset email failed', e))
      .finally(() => pendingMail.delete(p));
    pendingMail.add(p);
  }

  async function createSession(client, userId, meta) {
    const token = newToken(), t = now();
    await client.query(
      'insert into sessions(token_hash,user_id,created_at,last_seen_at,expires_at,ip,user_agent) values ($1,$2,$3,$3,$4,$5,$6)',
      [hashToken(token), userId, at(t), at(t + A.sessionDays * DAY), meta.ip || null, (meta.userAgent || '').slice(0, 300) || null]);
    return { token, maxAgeMs: A.sessionDays * DAY };
  }

  return {
    config: A,

    async register({ email, name, password }, meta = {}) {
      email = normalizeEmail(email); name = normalizeName(name);
      const fields = {};
      const e1 = validateEmail(email), e2 = validateName(name), e3 = validatePassword(password, { email, name });
      if (e1) fields.email = e1; if (e2) fields.name = e2; if (e3) fields.password = e3;
      if (Object.keys(fields).length) throw new AuthError(400, 'Please fix the highlighted fields.', fields);
      const hash = await passwords.hash(password);
      try {
        return await db.tx(async (t) => {
          const u = (await t.query('insert into users(email,display_name,password_hash) values ($1,$2,$3) returning id,email,display_name', [email, name, hash])).rows[0];
          if (onUserCreated) await onUserCreated(t, u.id);   // e.g. create the ₹10,00,000 portfolio atomically with the account
          const s = await createSession(t, u.id, meta);
          return { user: publicUser(u), session: s };
        });
      } catch (e) {
        if (e.code === '23505') throw new AuthError(409, 'An account with this email already exists. Try logging in instead.', { email: 'This email is already registered.' });
        throw e;
      }
    },

    async login({ email, password }, meta = {}) {
      const generic = new AuthError(401, 'Invalid email or password, or too many attempts. Wait a few minutes or reset your password.');
      email = normalizeEmail(email);
      if (validateEmail(email) || typeof password !== 'string' || !password || password.length > 128) { await passwords.fakeVerify('x'); throw generic; }
      const u = (await db.query('select * from users where email = $1', [email])).rows[0];
      if (!u) { await passwords.fakeVerify(password); throw generic; }
      if (u.locked_until && new Date(u.locked_until).getTime() > now()) { await passwords.fakeVerify(password); throw generic; }
      const ok = await passwords.verify(u.password_hash, password);
      if (!ok) {
        // One atomic statement: parallel wrong guesses cannot undercount (a read-then-write in JS would let them all see the same number).
        await db.query(
          `update users set failed_logins = case when failed_logins + 1 >= $2 then 0 else failed_logins + 1 end,
                            locked_until  = case when failed_logins + 1 >= $2 then $3::timestamptz else locked_until end
           where id = $1`, [u.id, A.maxFailedLogins, at(now() + A.lockMinutes * 60e3)]);
        throw generic;
      }
      return db.tx(async (t) => {
        let extra = '';
        const params = [u.id];
        if (passwords.needsRehash(u.password_hash)) { params.push(await passwords.hash(password)); extra = ', password_hash=$2'; }
        await t.query(`update users set failed_logins=0, locked_until=null${extra} where id=$1`, params);
        return { user: publicUser(u), session: await createSession(t, u.id, meta) };
      });
    },

    /** token -> user or null. Enforces absolute expiry and idle timeout, and refreshes last_seen. */
    async getSession(token) {
      if (!token || typeof token !== 'string' || token.length > 100) return null;
      const h = hashToken(token), t = now();
      const r = (await db.query(
        'select s.last_seen_at, s.expires_at, u.id, u.email, u.display_name from sessions s join users u on u.id = s.user_id where s.token_hash = $1', [h])).rows[0];
      if (!r) return null;
      const idleOk = t - new Date(r.last_seen_at).getTime() < A.idleDays * DAY, absOk = new Date(r.expires_at).getTime() > t;
      if (!idleOk || !absOk) { await db.query('delete from sessions where token_hash=$1', [h]); return null; }
      if (t - new Date(r.last_seen_at).getTime() > A.touchEveryMs) await db.query('update sessions set last_seen_at=$2 where token_hash=$1', [h, at(t)]);
      return publicUser(r);
    },

    async logout(token) { if (token) await db.query('delete from sessions where token_hash=$1', [hashToken(String(token).slice(0, 100))]); },

    /** Always resolves the same way whether or not the email exists. */
    async requestReset({ email }) {
      // Decided before looking at the email, so the answer reveals nothing about which accounts exist.
      if (mailer.available === false) { const e = new AuthError(503, 'Password reset by email is not available on this server right now. Please contact the site owner.'); e.code = 'EMAIL_UNAVAILABLE'; throw e; }
      email = normalizeEmail(email);
      if (validateEmail(email)) return;
      const u = (await db.query('select id,email,display_name from users where email=$1', [email])).rows[0];
      if (!u) return;
      // Throttle mail bombing: a short cooldown AND an hourly cap per account, so a victim's inbox cannot be flooded even from many IPs.
      const t = now();
      const recent = (await db.query('select count(*)::int as n, max(created_at) as last from password_resets where user_id=$1 and created_at > $2', [u.id, at(t - 3600e3)])).rows[0];
      if (recent.last && t - new Date(recent.last).getTime() < A.resetCooldownSec * 1000) return;
      if (recent.n >= A.resetMaxPerHour) return;
      const token = newToken();
      await db.tx(async (tx) => {
        // Only the newest link works: earlier unused links are expired the moment a new one is issued.
        await tx.query('update password_resets set expires_at=$2 where user_id=$1 and used_at is null and expires_at > $2', [u.id, at(t)]);
        await tx.query('insert into password_resets(token_hash,user_id,created_at,expires_at) values ($1,$2,$3,$4)', [hashToken(token), u.id, at(t), at(t + A.resetMinutes * 60e3)]);
      });
      // The link host comes from configuration, never from the request's Host header (prevents poisoned reset links).
      const link = `${config.appUrl}/reset-password#token=${token}`;
      sendInBackground({ to: u.email, ...resetEmail({ name: u.display_name, link, minutes: A.resetMinutes }) });
    },

    /** Resolves when every reset email handed to the provider has finished (success or failure). Used by tests and graceful shutdown. */
    async flushMail() { await Promise.allSettled([...pendingMail]); },

    async resetPassword({ token, password }) {
      const bad = new AuthError(400, 'This reset link is invalid or has expired. Request a new one.');
      if (!token || typeof token !== 'string' || token.length > 100) throw bad;
      const h = hashToken(token), t = now();
      return db.tx(async (tx) => {
        // Atomically claim the token: two simultaneous submissions cannot both succeed.
        const r = (await tx.query('update password_resets set used_at=$2 where token_hash=$1 and used_at is null and expires_at > $2 returning user_id', [h, at(t)])).rows[0];
        if (!r) throw bad;
        const u = (await tx.query('select id,email,display_name from users where id=$1', [r.user_id])).rows[0];
        const err = validatePassword(password, { email: u.email, name: u.display_name });
        if (err) throw new AuthError(400, 'Please choose a different password.', { password: err });
        await tx.query('update users set password_hash=$2, password_changed_at=$3, updated_at=$3, failed_logins=0, locked_until=null where id=$1', [u.id, await passwords.hash(password), at(t)]);
        await tx.query('delete from sessions where user_id=$1', [u.id]);                 // sign out everywhere
        await tx.query('update password_resets set used_at=$2 where user_id=$1 and used_at is null', [u.id, at(t)]);
        return { user: publicUser(u) };
      });
    },

    async changePassword(userId, { currentPassword, newPassword }, keepToken) {
      const u = (await db.query('select * from users where id=$1', [userId])).rows[0];
      if (!u || !(await passwords.verify(u.password_hash, currentPassword || ''))) throw new AuthError(400, 'Your current password is not correct.', { currentPassword: 'Incorrect password.' });
      const err = validatePassword(newPassword, { email: u.email, name: u.display_name });
      if (err) throw new AuthError(400, 'Please choose a different password.', { newPassword: err });
      const hash = await passwords.hash(newPassword);
      await db.tx(async (t) => {
        await t.query('update users set password_hash=$2, password_changed_at=$3, updated_at=$3 where id=$1', [userId, hash, at(now())]);
        await t.query('delete from sessions where user_id=$1 and token_hash <> $2', [userId, keepToken ? hashToken(keepToken) : '']);
      });
    },

    /** Permanently deletes the account and everything it owns (foreign keys cascade: portfolio, positions, orders, transactions, watchlist, snapshots, sessions...).
     *  Requires the current password. The append-only order audit log keeps only anonymous order ids once the user row is gone. */
    async deleteAccount(userId, { password, confirm } = {}) {
      if (confirm !== 'DELETE') throw new AuthError(400, 'Type DELETE to confirm.', { confirm: 'Type DELETE to confirm.' });
      const u = (await db.query('select * from users where id=$1', [userId])).rows[0];
      if (!u || !(await passwords.verify(u.password_hash, typeof password === 'string' ? password : ''))) throw new AuthError(400, 'Your password is not correct.', { password: 'Incorrect password.' });
      await db.tx(async (t) => {
        await t.query('select 1 from portfolios where user_id=$1 for update', [userId]);   // wait for any in-flight trade or matcher pass on this account
        await t.query('delete from users where id=$1', [userId]);
      });
      log.info('account deleted', { userId });
    },

    async purgeExpired() {
      const t = at(now());
      await db.query('delete from sessions where expires_at < $1 or last_seen_at < $2', [t, at(now() - A.idleDays * DAY)]);
      await db.query('delete from password_resets where expires_at < $1', [at(now() - DAY)]);
    },
  };
}
