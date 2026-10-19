// Structured logging: one JSON object per line on stdout (what Render, Docker and log search tools expect).
// Secrets never reach the log: sensitive field names are masked and credentials inside URLs are stripped.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE = /pass(word)?|token|secret|authorization|cookie|api[-_]?key|database_url|connection/i;

export function scrubString(s) {
  return String(s).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***:***@');   // postgres://user:pw@host -> postgres://***:***@host
}
export function serializeError(e) {
  if (!(e instanceof Error)) return { message: scrubString(e) };
  return { name: e.name, message: scrubString(e.message), code: e.code, stack: e.stack ? scrubString(e.stack).split('\n').slice(0, 6).join('\n') : undefined };
}
function clean(v, depth = 0) {
  if (v instanceof Error) return serializeError(v);
  if (typeof v === 'string') return scrubString(v);
  if (v === null || typeof v !== 'object') return v;
  if (depth > 3) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SENSITIVE.test(k) ? '[redacted]' : clean(x, depth + 1);
  return out;
}

export function createLogger({ write = (line) => process.stdout.write(line + '\n'), level, base = {}, now = () => new Date() } = {}) {
  const threshold = () => LEVELS[level ?? process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold()) return;
    const f = fields instanceof Error ? { err: fields } : fields || {};
    const rec = { time: now().toISOString(), level: lvl, msg: scrubString(msg), ...base, ...clean(f) };
    try { write(JSON.stringify(rec)); } catch { /* logging must never crash the app */ }
  };
  const log = { debug: (m, f) => emit('debug', m, f), info: (m, f) => emit('info', m, f), warn: (m, f) => emit('warn', m, f), error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ write, level, base: { ...base, ...extra }, now }) };
  return log;
}
export const log = createLogger({ base: { app: 'investbrick' } });
