// NSE/BSE equity-segment trading calendar (IST). Holidays below are the 2026 weekday
// holidays published by NSE; verify yearly at nseindia.com -> Resources -> Holidays.
const HOLIDAYS = new Set([
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03',
  '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02',
  '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
]);
const IST_OFFSET_MIN = 330;

export function istParts(date) {
  const d = new Date(date.getTime() + IST_OFFSET_MIN * 60000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return {
    ymd: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    dow: d.getUTCDay(), // 0 Sun .. 6 Sat
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** @returns {{state:'open'|'pre-open'|'closed', reason:string, label:string}} */
export function nseStatus(now = new Date()) {
  const { ymd, dow, minutes } = istParts(now);
  if (dow === 0 || dow === 6) return { state: 'closed', reason: 'weekend', label: 'NSE closed (weekend)' };
  if (HOLIDAYS.has(ymd)) return { state: 'closed', reason: 'holiday', label: 'NSE closed (market holiday)' };
  if (minutes >= 9 * 60 && minutes < 9 * 60 + 15) return { state: 'pre-open', reason: 'pre-open', label: 'NSE pre-open session' };
  if (minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30) return { state: 'open', reason: 'regular', label: 'NSE open' };
  return { state: 'closed', reason: 'after-hours', label: 'NSE closed (outside 9:15–15:30 IST)' };
}
export const cryptoStatus = () => ({ state: 'open', reason: '24x7', label: 'Crypto trades 24×7' });
export const statusFor = (inst, now) => (inst.market === 'CRYPTO' ? cryptoStatus() : nseStatus(now));
export const _HOLIDAYS = HOLIDAYS;
