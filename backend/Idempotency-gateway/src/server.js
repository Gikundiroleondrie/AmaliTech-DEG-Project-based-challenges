'use strict';

const http = require('http');
const crypto = require('crypto');
const { IdempotencyStore } = require('./store');

const MAX_KEY_LENGTH = 255;
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const fingerprintOf = (body) =>
  crypto.createHash('sha256').update(canonicalize(body)).digest('hex');

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(Object.assign(new Error('Payload too large.'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function validatePayment(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object.';
  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) {
    return '"amount" must be a positive number.';
  }
  if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency)) {
    return '"currency" must be a 3-letter currency code (e.g. GHS).';
  }
  return null;
}

async function chargeCustomer({ amount, currency }, delayMs) {
  await sleep(delayMs);
  return {
    statusCode: 201,
    body: {
      status: `Charged ${amount} ${currency}`,
      transactionId: crypto.randomUUID(),
      amount,
      currency,
    },
  };
}

function createServer({ delayMs = 2000, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  const store = new IdempotencyStore({ ttlMs });
  store.startSweeper();

  async function handlePayment(req, res) {
    const key = req.headers['idempotency-key'];
    if (!key) {
      return send(res, 400, { error: 'Missing required header: Idempotency-Key.' });
    }
    if (key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
      return send(res, 400, {
        error: `Idempotency-Key must be 1-${MAX_KEY_LENGTH} characters of letters, digits, ".", "_", ":" or "-".`,
      });
    }

    const body = await readJson(req);
    const problem = validatePayment(body);
    if (problem) return send(res, 400, { error: problem });

    const fingerprint = fingerprintOf(body);

    for (;;) {
      const existing = store.get(key);

      if (!existing) {
        const entry = store.begin(key, fingerprint);
        try {
          const response = await chargeCustomer(body, delayMs);
          store.complete(key, entry, response);
          return send(res, response.statusCode, response.body, { 'X-Cache-Hit': 'false' });
        } catch (err) {
          store.fail(key, entry, err);
          throw err;
        }
      }

      if (existing.fingerprint !== fingerprint) {
        return send(res, 422, { error: 'Idempotency key already used for a different request body.' });
      }

      if (existing.status === 'processing') {
        try {
          await existing.promise;
        } catch {
          continue;
        }
      }

      const saved = existing.response || store.get(key)?.response;
      if (!saved) continue;
      return send(res, saved.statusCode, saved.body, { 'X-Cache-Hit': 'true' });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (req.method === 'POST' && pathname === '/process-payment') return await handlePayment(req, res);
      if (req.method === 'GET' && pathname === '/health') return send(res, 200, { status: 'ok', storedKeys: store.size });

      send(res, 404, { error: 'Not found.' });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode === 500) console.error(err);
      if (!res.headersSent) send(res, statusCode, { error: statusCode === 500 ? 'Internal server error.' : err.message });
    }
  });

  server.on('close', () => store.stopSweeper());
  return { server, store };
}

module.exports = { createServer, canonicalize };
