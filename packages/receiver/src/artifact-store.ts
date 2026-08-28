import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type {
  CaptureCompleteResponse,
  CaptureMetadata,
  CapturePaths,
  CaptureStartResponse,
  LatestManifest,
} from './protocol.js';
import { PROTOCOL_VERSION, ReceiverError, TRACE_SOURCE } from './protocol.js';

const CHUNK_FILE_DIGITS = 8;
const MAX_SEQUENCE = 99_999_999;

interface CaptureSession {
  uploadId: string;
  metadata: CaptureMetadata;
  safeUrl: string;
  host: string;
  paths: CapturePaths;
  absoluteCaptureDir: string;
  absoluteChunksDir: string;
  absoluteTrace: string;
  absoluteManifest: string;
  sequences: Set<number>;
  traceEventCount: number;
}

function formatCaptureTime(value: string): string {
  const date = new Date(value);
  const pad = (part: number): string => String(part).padStart(2, '0');

  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

function sanitizeHost(host: string): string {
  const sanitized = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return sanitized || 'page';
}

function redactUrl(value: string): { url: string; host: string } {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.hash = '';

  const sensitiveKey = /(?:^|[_-])(auth|code|credential|jwt|key|secret|session|sig|token)(?:$|[_-])/i;
  for (const key of [...url.searchParams.keys()]) {
    if (sensitiveKey.test(key)) {
      url.searchParams.set(key, '<redacted>');
    }
  }

  return { url: url.toString(), host: url.host };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

async function writeFully(
  file: Awaited<ReturnType<typeof open>>,
  value: string,
): Promise<void> {
  const buffer = Buffer.from(value);
  let offset = 0;

  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    offset += bytesWritten;
  }
}

export class ArtifactStore {
  readonly rootDir: string;
  readonly artifactRoot: string;
  readonly latestManifestPath: string;

  private readonly sessions = new Map<string, CaptureSession>();

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    this.artifactRoot = join(this.rootDir, '.rsdoctor-performance');
    this.latestManifestPath = join(this.artifactRoot, 'latest.json');
  }

  async start(metadata: CaptureMetadata): Promise<CaptureStartResponse> {
    await mkdir(this.artifactRoot, { recursive: true });

    const { url: safeUrl, host } = redactUrl(metadata.url);
    const baseCaptureId = `${formatCaptureTime(metadata.capturedAt)}-${sanitizeHost(host)}`;
    const captureId = await this.getAvailableCaptureId(baseCaptureId);
    const absoluteCaptureDir = join(this.artifactRoot, captureId);
    const absoluteChunksDir = join(absoluteCaptureDir, '.chunks');
    const absoluteTrace = join(absoluteCaptureDir, 'trace.json');
    const absoluteManifest = join(absoluteCaptureDir, 'manifest.json');

    await mkdir(absoluteChunksDir, { recursive: true });

    const paths: CapturePaths = {
      captureId,
      captureDir: this.toWorkspacePath(absoluteCaptureDir),
      trace: this.toWorkspacePath(absoluteTrace),
      manifest: this.toWorkspacePath(absoluteManifest),
      latestManifest: this.toWorkspacePath(this.latestManifestPath),
    };
    const uploadId = randomUUID();
    const session: CaptureSession = {
      uploadId,
      metadata,
      safeUrl,
      host,
      paths,
      absoluteCaptureDir,
      absoluteChunksDir,
      absoluteTrace,
      absoluteManifest,
      sequences: new Set(),
      traceEventCount: 0,
    };

    this.sessions.set(uploadId, session);
    await writeJsonAtomic(
      absoluteManifest,
      this.createManifest(session, 'capturing', null, null, null),
    );

    return { ok: true, state: 'capturing', uploadId, ...paths };
  }

  async writeChunk(
    uploadId: string,
    sequence: number,
    traceEvents: unknown[],
  ): Promise<void> {
    const session = this.getSession(uploadId);

    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_SEQUENCE) {
      throw new ReceiverError('Invalid chunk sequence.', 400, 'INVALID_SEQUENCE');
    }
    if (session.sequences.has(sequence)) {
      throw new ReceiverError('Chunk sequence already exists.', 409, 'DUPLICATE_CHUNK');
    }

    const chunkPath = this.getChunkPath(session, sequence);
    await writeFile(chunkPath, JSON.stringify(traceEvents), { encoding: 'utf8', flag: 'wx' });
    session.sequences.add(sequence);
    session.traceEventCount += traceEvents.length;
  }

  async finish(uploadId: string, lastSequence: number): Promise<CaptureCompleteResponse> {
    const session = this.getSession(uploadId);
    this.validateSequenceSet(session, lastSequence);

    const temporaryTrace = `${session.absoluteTrace}.${randomUUID()}.tmp`;
    const file = await open(temporaryTrace, 'wx');

    try {
      await writeFully(file, '{"traceEvents":[');
      let hasEvents = false;

      for (let sequence = 0; sequence <= lastSequence; sequence += 1) {
        const rawChunk = await readFile(this.getChunkPath(session, sequence), 'utf8');
        if (!rawChunk.startsWith('[') || !rawChunk.endsWith(']')) {
          throw new ReceiverError('Stored trace chunk is invalid.', 500, 'INVALID_CHUNK');
        }

        const events = rawChunk.slice(1, -1);
        if (events.length === 0) {
          continue;
        }
        if (hasEvents) {
          await writeFully(file, ',');
        }
        await writeFully(file, events);
        hasEvents = true;
      }

      await writeFully(file, ']}\n');
      await file.sync();
    } catch (error) {
      await file.close();
      await rm(temporaryTrace, { force: true });
      throw error;
    }

    await file.close();
    await rename(temporaryTrace, session.absoluteTrace);

    const traceStats = await stat(session.absoluteTrace);
    const manifest = this.createManifest(
      session,
      'completed',
      session.paths.trace,
      session.traceEventCount,
      traceStats.size,
    );

    await writeJsonAtomic(session.absoluteManifest, manifest);
    await writeJsonAtomic(this.latestManifestPath, manifest);
    await rm(session.absoluteChunksDir, { recursive: true, force: true });
    this.sessions.delete(uploadId);

    return {
      ok: true,
      state: 'completed',
      ...session.paths,
      traceEventCount: session.traceEventCount,
      traceBytes: traceStats.size,
    };
  }

  async abort(uploadId: string): Promise<void> {
    const session = this.getSession(uploadId);
    await rm(session.absoluteChunksDir, { recursive: true, force: true });
    await writeJsonAtomic(
      session.absoluteManifest,
      this.createManifest(session, 'aborted', null, null, null),
    );
    this.sessions.delete(uploadId);
  }

  private async getAvailableCaptureId(baseCaptureId: string): Promise<string> {
    let candidate = baseCaptureId;
    let suffix = 2;

    while (await pathExists(join(this.artifactRoot, candidate))) {
      candidate = `${baseCaptureId}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  private getSession(uploadId: string): CaptureSession {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new ReceiverError('Capture upload was not found.', 404, 'CAPTURE_NOT_FOUND');
    }
    return session;
  }

  private getChunkPath(session: CaptureSession, sequence: number): string {
    return join(
      session.absoluteChunksDir,
      `${String(sequence).padStart(CHUNK_FILE_DIGITS, '0')}.json`,
    );
  }

  private validateSequenceSet(session: CaptureSession, lastSequence: number): void {
    if (
      !Number.isSafeInteger(lastSequence) ||
      lastSequence < -1 ||
      lastSequence > MAX_SEQUENCE
    ) {
      throw new ReceiverError('Invalid last chunk sequence.', 400, 'INVALID_SEQUENCE');
    }
    if (session.sequences.size !== lastSequence + 1) {
      throw new ReceiverError('One or more trace chunks are missing.', 409, 'MISSING_CHUNK');
    }
    for (let sequence = 0; sequence <= lastSequence; sequence += 1) {
      if (!session.sequences.has(sequence)) {
        throw new ReceiverError('One or more trace chunks are missing.', 409, 'MISSING_CHUNK');
      }
    }
  }

  private createManifest(
    session: CaptureSession,
    state: LatestManifest['state'],
    trace: string | null,
    traceEventCount: number | null,
    traceBytes: number | null,
  ): LatestManifest {
    return {
      version: PROTOCOL_VERSION,
      source: TRACE_SOURCE,
      state,
      captureId: session.paths.captureId,
      capturedAt: session.metadata.capturedAt,
      url: session.safeUrl,
      host: session.host,
      authState: 'user-authenticated',
      cacheState: session.metadata.cacheState,
      mode: session.metadata.mode,
      trace,
      traceSummary: null,
      networkSummary: null,
      scriptCostSummary: null,
      longTaskContext: null,
      bundleSummary: null,
      correlationReport: null,
      diagnosis: null,
      traceEventCount,
      traceBytes,
    };
  }

  private toWorkspacePath(absolutePath: string): string {
    return relative(this.rootDir, absolutePath).split(sep).join('/');
  }
}
