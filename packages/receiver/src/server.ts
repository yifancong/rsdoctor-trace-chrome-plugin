import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { ArtifactStore } from './artifact-store.js';
import {
  CACHE_STATES,
  CAPTURE_MODES,
  PROTOCOL_VERSION,
  ReceiverError,
  TRACE_SOURCE,
  type CaptureMetadata,
} from './protocol.js';

const DEFAULT_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export interface TraceReceiverOptions {
  rootDir: string;
  bodyLimitBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ReceiverError(`Invalid ${key}.`, 400, 'INVALID_REQUEST');
  }
  return value;
}

function parseMetadata(value: unknown): CaptureMetadata {
  if (!isRecord(value)) {
    throw new ReceiverError('Expected a JSON object.', 400, 'INVALID_REQUEST');
  }
  if (value.version !== PROTOCOL_VERSION || value.source !== TRACE_SOURCE) {
    throw new ReceiverError('Unsupported capture protocol.', 400, 'INVALID_PROTOCOL');
  }

  const url = requireString(value, 'url', 8_192);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ReceiverError('Invalid capture URL.', 400, 'INVALID_URL');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ReceiverError('Only HTTP(S) page URLs are supported.', 400, 'INVALID_URL');
  }

  const capturedAt = requireString(value, 'capturedAt', 64);
  if (Number.isNaN(Date.parse(capturedAt))) {
    throw new ReceiverError('Invalid capture timestamp.', 400, 'INVALID_TIMESTAMP');
  }

  const cacheState = value.cacheState;
  const mode = value.mode;
  if (!CACHE_STATES.includes(cacheState as (typeof CACHE_STATES)[number])) {
    throw new ReceiverError('Invalid cache state.', 400, 'INVALID_REQUEST');
  }
  if (!CAPTURE_MODES.includes(mode as (typeof CAPTURE_MODES)[number])) {
    throw new ReceiverError('Invalid capture mode.', 400, 'INVALID_REQUEST');
  }

  return {
    version: PROTOCOL_VERSION,
    source: TRACE_SOURCE,
    url,
    title: requireString(value, 'title', 512),
    capturedAt,
    cacheState: cacheState as CaptureMetadata['cacheState'],
    mode: mode as CaptureMetadata['mode'],
  };
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin !== undefined && !CHROME_EXTENSION_ORIGIN.test(origin)) {
    throw new ReceiverError('Origin is not allowed.', 403, 'ORIGIN_NOT_ALLOWED');
  }
  if (origin !== undefined) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
}

async function readJson(request: IncomingMessage, bodyLimitBytes: number): Promise<unknown> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new ReceiverError('Content-Type must be application/json.', 415, 'INVALID_CONTENT_TYPE');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > bodyLimitBytes) {
      throw new ReceiverError('Request body is too large.', 413, 'BODY_TOO_LARGE');
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ReceiverError('Request body is not valid JSON.', 400, 'INVALID_JSON');
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function asInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) {
    throw new ReceiverError(`Invalid ${key}.`, 400, 'INVALID_REQUEST');
  }
  return value as number;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: ArtifactStore,
  bodyLimitBytes: number,
): Promise<void> {
  applyCors(request, response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', 'http://receiver.local');
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'rsdoctor-trace-receiver',
      version: PROTOCOL_VERSION,
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/captures') {
    const body = await readJson(request, bodyLimitBytes);
    const metadata = parseMetadata(body);
    const started = await store.start(metadata);

    if (isRecord(body) && Array.isArray(body.traceEvents)) {
      if (body.traceEvents.length > 0) {
        await store.writeChunk(started.uploadId, 0, body.traceEvents);
      }
      const completed = await store.finish(
        started.uploadId,
        body.traceEvents.length > 0 ? 0 : -1,
      );
      sendJson(response, 201, completed);
      return;
    }

    sendJson(response, 201, started);
    return;
  }

  const match = /^\/api\/captures\/([0-9a-f-]+)\/(chunks|finish|abort)$/.exec(
    url.pathname,
  );
  if (request.method === 'POST' && match) {
    const uploadId = match[1];
    const action = match[2];
    if (uploadId === undefined || action === undefined) {
      throw new ReceiverError('Invalid capture route.', 400, 'INVALID_REQUEST');
    }

    if (action === 'abort') {
      await store.abort(uploadId);
      sendJson(response, 200, { ok: true, state: 'aborted' });
      return;
    }

    const body = await readJson(request, bodyLimitBytes);
    if (!isRecord(body)) {
      throw new ReceiverError('Expected a JSON object.', 400, 'INVALID_REQUEST');
    }

    if (action === 'chunks') {
      if (!Array.isArray(body.traceEvents)) {
        throw new ReceiverError('traceEvents must be an array.', 400, 'INVALID_REQUEST');
      }
      await store.writeChunk(uploadId, asInteger(body, 'sequence'), body.traceEvents);
      sendJson(response, 202, { ok: true });
      return;
    }

    const completed = await store.finish(uploadId, asInteger(body, 'lastSequence'));
    sendJson(response, 200, completed);
    return;
  }

  throw new ReceiverError('Route was not found.', 404, 'NOT_FOUND');
}

export function createTraceReceiver(options: TraceReceiverOptions): Server {
  const store = new ArtifactStore(resolve(options.rootDir));
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;

  return createServer((request, response) => {
    void handleRequest(request, response, store, bodyLimitBytes).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }

      if (error instanceof ReceiverError) {
        sendJson(response, error.statusCode, {
          ok: false,
          error: { code: error.code, message: error.message },
        });
        return;
      }

      console.error(error);
      sendJson(response, 500, {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'The receiver failed unexpectedly.' },
      });
    });
  });
}
