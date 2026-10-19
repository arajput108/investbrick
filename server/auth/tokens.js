import crypto from 'node:crypto';
export const newToken = () => crypto.randomBytes(32).toString('base64url');          // 256 bits
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
