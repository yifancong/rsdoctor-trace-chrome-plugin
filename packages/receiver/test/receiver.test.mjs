import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createTraceReceiver } from '../dist/server.js';

const extensionOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startReceiver() {
  const rootDir = await mkdtemp(join(tmpdir(), 'rsdoctor-trace-test-'));
  const server = createTraceReceiver({ rootDir });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');

  cleanups.push(
    () => new Promise((resolve) => server.close(resolve)),
    () => rm(rootDir, { recursive: true, force: true }),
  );

  return { rootDir, origin: `http://127.0.0.1:${address.port}` };
}

async function request(origin, path, body, extraHeaders = {}) {
  return fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: extensionOrigin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function metadata(overrides = {}) {
  return {
    version: 1,
    source: 'rsdoctor-trace-extension',
    url: 'https://example.com/app?tenant=docs&access_token=secret-value#private',
    title: 'Authenticated app',
    capturedAt: '2026-08-27T03:04:05.000Z',
    cacheState: 'unknown',
    mode: 'authenticated-reload',
    ...overrides,
  };
}

test('streams ordered chunks and updates latest.json only after completion', async () => {
  const { rootDir, origin } = await startReceiver();

  const startResponse = await request(origin, '/api/captures', metadata());
  assert.equal(startResponse.status, 201);
  const started = await startResponse.json();
  assert.equal(started.state, 'capturing');

  await assert.rejects(readFile(join(rootDir, '.rsdoctor-performance/latest.json')));

  const firstChunk = await request(origin, `/api/captures/${started.uploadId}/chunks`, {
    sequence: 0,
    traceEvents: [{ name: 'navigationStart', ts: 1 }, { name: 'firstPaint', ts: 2 }],
  });
  assert.equal(firstChunk.status, 202);

  const secondChunk = await request(origin, `/api/captures/${started.uploadId}/chunks`, {
    sequence: 1,
    traceEvents: [{ name: 'largestContentfulPaint', ts: 3 }],
  });
  assert.equal(secondChunk.status, 202);

  const finishResponse = await request(origin, `/api/captures/${started.uploadId}/finish`, {
    lastSequence: 1,
  });
  assert.equal(finishResponse.status, 200);
  const completed = await finishResponse.json();
  assert.equal(completed.traceEventCount, 3);

  const trace = JSON.parse(await readFile(join(rootDir, completed.trace), 'utf8'));
  assert.deepEqual(
    trace.traceEvents.map((event) => event.name),
    ['navigationStart', 'firstPaint', 'largestContentfulPaint'],
  );

  const latest = JSON.parse(
    await readFile(join(rootDir, '.rsdoctor-performance/latest.json'), 'utf8'),
  );
  assert.equal(latest.state, 'completed');
  assert.equal(latest.trace, completed.trace);
  assert.equal(latest.traceSummary, null);
  assert.equal(latest.networkSummary, null);
  assert.equal(latest.url, 'https://example.com/app?tenant=docs&access_token=%3Credacted%3E');
});

test('supports the single-request automation contract', async () => {
  const { rootDir, origin } = await startReceiver();
  const response = await request(origin, '/api/captures', {
    ...metadata({ capturedAt: '2026-08-27T03:05:06.000Z' }),
    traceEvents: [{ name: 'RunTask', dur: 51_000 }],
  });

  assert.equal(response.status, 201);
  const completed = await response.json();
  assert.equal(completed.state, 'completed');
  assert.equal(completed.traceEventCount, 1);
  assert.deepEqual(
    JSON.parse(await readFile(join(rootDir, completed.trace), 'utf8')).traceEvents,
    [{ name: 'RunTask', dur: 51_000 }],
  );
});

test('rejects webpage origins and incomplete chunk sequences', async () => {
  const { origin } = await startReceiver();
  const rejected = await request(origin, '/api/captures', metadata(), {
    Origin: 'https://malicious.example',
  });
  assert.equal(rejected.status, 403);

  const startResponse = await request(
    origin,
    '/api/captures',
    metadata({ capturedAt: '2026-08-27T03:06:07.000Z' }),
  );
  const started = await startResponse.json();
  await request(origin, `/api/captures/${started.uploadId}/chunks`, {
    sequence: 1,
    traceEvents: [{ name: 'out-of-order' }],
  });

  const incomplete = await request(origin, `/api/captures/${started.uploadId}/finish`, {
    lastSequence: 1,
  });
  assert.equal(incomplete.status, 409);
  assert.equal((await incomplete.json()).error.code, 'MISSING_CHUNK');

  const aborted = await request(origin, `/api/captures/${started.uploadId}/abort`, {});
  assert.equal(aborted.status, 200);
});
