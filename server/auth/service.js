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
    sessionDays: 30, idleDays: 7, resetMinutes: 60, resetCooldownSec: 60, maxFailedLogins: 10, lockMinutes: 15, touchEveryMs: 10 * 60e3,
    ...config.auth,
  };
  const at = (ms) => new Date(ms);

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
        const fails = u.failed_logins + 1, lock = fails >= A.maxFailedLogins;
        await db.query('update users set failed_logins=$2, locked_until=$3 where id=$1', [u.id, lock ? 0 : fails, lock ? at(now() + A.lockMinutes * 60e3) : null]);
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
      email = normalizeEmail(email);
      if (validateEmail(email)) return;
      const u = (await db.query('select id,email,display_name from users where email=$1', [email])).rows[0];
      if (!u) return;
      const last = (await db.query('select created_at from password_resets where user_id=$1 order by created_at desc limit 1', [u.id])).rows[0];
      if (last && now() - new Date(last.created_at).getTime() < A.resetCooldownSec * 1000) return; // throttle mail bombing
      const token = newToken(), t = now();
      await db.query('insert into password_resets(token_hash,user_id,created_at,expires_at) values ($1,$2,$3,$4)', [hashToken(token), u.id, at(t), at(t + A.resetMinutes * 60e3)]);
      // The link host comes from configuration, never from the request's Host header (prevents poisoned reset links).
      const link = `${config.appUrl}/reset-password#token=${token}`;
      try { await mailer.send({ to: u.email, ...resetEmail({ name: u.display_name, link, minutes: A.resetMinutes }) }); }
      catch (e) { log.error('password reset email failed', e); }
    },

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

    async purgeExpired() {
      const t = at(now());
      await db.query('delete from sessions where expires_at < $1 or last_seen_at < $2', [t, at(now() - A.idleDays * DAY)]);
      await db.query('delete from password_resets where expires_at < $1', [at(now() - DAY)]);
    },
  };
}
