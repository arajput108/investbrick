const COMMON = new Set(`password password1 password12 password123 passw0rd 123456 1234567 12345678 123456789 1234567890 12345678910
qwerty qwerty123 qwertyuiop 1q2w3e4r 1q2w3e4r5t abc123 abcd1234 iloveyou admin admin123 welcome welcome1 letmein monkey dragon
football baseball master login princess sunshine shadow superman trustno1 whatever starwars zaq12wsx investbrick investbrick1
passwordpassword changeme default india123 india@123 password@123 admin@123 test1234 11111111 00000000 abcdefgh`.split(/\s+/));

export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}
export function validateEmail(email) {
  if (!email) return 'Enter your email address.';
  if (email.length > EMAIL_MAX) return 'That email address is too long.';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(email) || !/^[^@]+@[^@.]+(\.[^@.]+)*\.[a-z0-9-]{2,}$/i.test(email)) return 'Enter a valid email address, like name@example.com.';
  if (email.split('@')[0].length > 64) return 'That email address is not valid.';
  return null;
}
export function normalizeName(v) {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim() : '';
}
export function validateName(name) {
  if (!name) return 'Enter your name.';
  if (name.length > 60) return 'Keep your name under 60 characters.';
  return null;
}
/** Returns an error string or null. Unicode is allowed; NFKC-normalised so the same typed text always matches. */
export function normalizePassword(v) { return typeof v === 'string' ? v.normalize('NFKC') : ''; }
export function validatePassword(pw, { email = '', name = '' } = {}) {
  if (!pw) return 'Enter a password.';
  if (pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw)) return 'That password is too common. Choose something harder to guess.';
  const local = email.split('@')[0];
  if (local.length >= 4 && low.includes(local)) return 'Do not include your email name in your password.';
  const first = name.split(' ')[0].toLowerCase();
  if (first.length >= 4 && low === first) return 'Do not use your name as your password.';
  if (new Set(pw).size < 5) return 'Use a few more different characters.';
  return null;
}
