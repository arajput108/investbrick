export async function getJson(fetchImpl, url, { headers = {}, timeoutMs = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!res.ok) {
      const e = new Error(`upstream HTTP ${res.status}`); e.status = res.status;
      const ra = Number(res.headers?.get?.('retry-after')); if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = Math.min(ra, 900) * 1000;   // seconds -> ms, capped at 15 min
      throw e;
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('upstream timeout');
    throw e;
  } finally { clearTimeout(t); }
}
export const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
