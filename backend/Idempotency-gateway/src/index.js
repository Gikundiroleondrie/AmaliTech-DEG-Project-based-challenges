'use strict';

const { createServer } = require('./server');

const PORT = Number(process.env.PORT) || 3000;
const delayMs = process.env.PROCESSING_DELAY_MS !== undefined ? Number(process.env.PROCESSING_DELAY_MS) : 2000;
const ttlMs = process.env.KEY_TTL_MS !== undefined ? Number(process.env.KEY_TTL_MS) : 24 * 60 * 60 * 1000;

const { server } = createServer({ delayMs, ttlMs });

server.listen(PORT, () => {
  console.log(`Idempotency Gateway listening on http://localhost:${PORT}`);
  console.log(`  processing delay: ${delayMs}ms | key TTL: ${ttlMs / 1000}s`);
});
