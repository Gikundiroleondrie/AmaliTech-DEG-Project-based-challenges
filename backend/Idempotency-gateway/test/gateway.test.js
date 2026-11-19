'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

const DELAY = 300;
let server, base;

before(async () => {
  ({ server } = createServer({ delayMs: DELAY, ttlMs: 1000 }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const pay = (key, body, extra = {}) =>
  fetch(`${base}/process-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}), ...extra },
    body: JSON.stringify(body),
  });

test('US1: first request is processed and charged', async () => {
  const start = Date.now();
  const res = await pay('k-happy', { amount: 100, currency: 'GHS' });
  const json = await res.json();
  assert.equal(res.status, 201);
  assert.equal(json.status, 'Charged 100 GHS');
  assert.ok(Date.now() - start >= DELAY - 20, 'should simulate processing delay');
  assert.equal(res.headers.get('x-cache-hit'), 'false');
});

test('US2: duplicate returns identical response instantly with X-Cache-Hit', async () => {
  const first = await pay('k-dup', { amount: 100, currency: 'GHS' });
  const firstBody = await first.json();

  const start = Date.now();
  const second = await pay('k-dup', { currency: 'GHS', amount: 100 }); // key order differs on purpose
  const secondBody = await second.json();

  assert.ok(Date.now() - start < DELAY / 2, 'replay must not re-run the delay');
  assert.equal(second.status, first.status);
  assert.deepEqual(secondBody, firstBody); // same transactionId => not charged twice
  assert.equal(second.headers.get('x-cache-hit'), 'true');
});

test('US3: same key with different body is rejected with 422', async () => {
  await pay('k-fraud', { amount: 100, currency: 'GHS' });
  const res = await pay('k-fraud', { amount: 500, currency: 'GHS' });
  const json = await res.json();
  assert.equal(res.status, 422);
  assert.equal(json.error, 'Idempotency key already used for a different request body.');
});

test('Bonus: in-flight duplicate waits and gets the first result (no 409, no double charge)', async () => {
  const body = { amount: 42, currency: 'USD' };
  const start = Date.now();
  const a = pay('k-race', body);
  await new Promise((r) => setTimeout(r, 50)); // B arrives while A is mid-processing
  const b = pay('k-race', body);
  const [ra, rb] = await Promise.all([a, b]);
  const [ja, jb] = [await ra.json(), await rb.json()];

  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  assert.equal(ja.transactionId, jb.transactionId);
  assert.equal(rb.headers.get('x-cache-hit'), 'true');
  assert.ok(Date.now() - start < DELAY * 1.8, 'B must not trigger a second processing run');
});

test('Many simultaneous duplicates produce exactly one charge', async () => {
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => pay('k-burst', { amount: 7, currency: 'EUR' })),
  );
  const ids = new Set();
  for (const r of responses) ids.add((await r.json()).transactionId);
  assert.equal(ids.size, 1);
  assert.equal(responses.filter((r) => r.headers.get('x-cache-hit') === 'false').length, 1);
});

test('Validation: missing key, bad key, bad body', async () => {
  assert.equal((await pay(null, { amount: 1, currency: 'GHS' })).status, 400);
  assert.equal((await pay('bad key!', { amount: 1, currency: 'GHS' })).status, 400);
  assert.equal((await pay('k-bad', { amount: -5, currency: 'GHS' })).status, 400);
  assert.equal((await pay('k-bad2', { amount: 5, currency: 'GHSX' })).status, 400);
});

test("Developer's Choice: keys expire after the TTL and can be reused", async () => {
  const r1 = await pay('k-ttl', { amount: 10, currency: 'GHS' });
  const j1 = await r1.json();
  await new Promise((r) => setTimeout(r, 1100)); // TTL is 1000ms in tests
  const r2 = await pay('k-ttl', { amount: 999, currency: 'GHS' }); // different body is fine after expiry
  const j2 = await r2.json();
  assert.equal(r2.status, 201);
  assert.notEqual(j1.transactionId, j2.transactionId);
  assert.equal(r2.headers.get('x-cache-hit'), 'false');
});
