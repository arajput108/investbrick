// npm run dev:local : run with a local on-disk Postgres (PGlite), no Neon needed. Development only.
process.env.DB_DRIVER ||= 'pglite';
await import('../server/index.js');
