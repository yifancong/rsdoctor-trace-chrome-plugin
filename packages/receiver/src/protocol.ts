export const PROTOCOL_VERSION = 1 as const;
export const TRACE_SOURCE = 'rsdoctor-trace-extension' as const;

export const CAPTURE_MODES = [
  'authenticated-reload',
  'current-state-interaction',
] as const;

export const CACHE_STATES = ['cold', 'warm', 'unknown'] as const;

export type CaptureMode = (typeof CAPTURE_MODES)[number];
export type CacheState = (typeof CACHE_STATES)[number];

export interface CaptureMetadata {
  version: typeof PROTOCOL_VERSION;
  source: typeof TRACE_SOURCE;
  url: string;
  title: string;
  capturedAt: string;
  cacheState: CacheState;
  mode: CaptureMode;
}

export interface CapturePaths {
  captureId: string;
  captureDir: string;
  trace: string;
  manifest: string;
  latestManifest: string;
}

export interface CaptureStartResponse extends CapturePaths {
  ok: true;
  state: 'capturing';
  uploadId: string;
}

export interface CaptureCompleteResponse extends CapturePaths {
  ok: true;
  state: 'completed';
  traceEventCount: number;
  traceBytes: number;
}

export interface LatestManifest {
  version: typeof PROTOCOL_VERSION;
  source: typeof TRACE_SOURCE;
  state: 'capturing' | 'completed' | 'aborted';
  captureId: string;
  capturedAt: string;
  url: string;
  host: string;
  authState: 'user-authenticated';
  cacheState: CacheState;
  mode: CaptureMode;
  trace: string | null;
  traceSummary: string | null;
  networkSummary: string | null;
  scriptCostSummary: string | null;
  longTaskContext: string | null;
  bundleSummary: string | null;
  correlationReport: string | null;
  diagnosis: string | null;
  traceEventCount: number | null;
  traceBytes: number | null;
}

export class ReceiverError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ReceiverError';
  }
}
