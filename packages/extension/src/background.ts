export {};

const RECEIVER_DEFAULT = 'http://127.0.0.1:43119';
const STATE_KEY = 'rsdoctorTraceCaptureState';
const DEBUGGER_PROTOCOL_VERSION = '1.3';

const TRACE_CATEGORIES = [
  'blink.console',
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.screenshot',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-lighthouse',
  'disabled-by-default-lighthouse.v8',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
  'latencyInfo',
  'loading',
  'renderer.scheduler',
  'v8.execute',
].join(',');

type CaptureMode = 'authenticated-reload' | 'current-state-interaction';
type CapturePhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'error';

interface StoredCaptureState {
  phase: CapturePhase;
  message: string;
  captureId: string | null;
  startedAt: string | null;
  mode: CaptureMode | null;
  tabId: number | null;
  receiverOrigin: string | null;
  uploadId: string | null;
  nextSequence: number;
}

interface PublicCaptureState {
  phase: CapturePhase;
  message: string;
  captureId: string | null;
  startedAt: string | null;
  mode: CaptureMode | null;
}

interface ReceiverStartResponse {
  ok: true;
  state: 'capturing';
  uploadId: string;
  captureId: string;
}

interface ReceiverCompleteResponse {
  ok: true;
  state: 'completed';
  captureId: string;
  trace: string;
  latestManifest: string;
  traceEventCount: number;
  traceBytes: number;
}

interface ReceiverErrorResponse {
  ok: false;
  error?: { message?: string };
}

interface ActiveCapture {
  tabId: number;
  receiverOrigin: string;
  uploadId: string;
  captureId: string;
  mode: CaptureMode;
  startedAt: string;
  nextSequence: number;
  finalizing: boolean;
}

type RequestMessage =
  | { type: 'GET_STATE' }
  | { type: 'CHECK_RECEIVER'; receiverUrl: string }
  | { type: 'START_CAPTURE'; receiverUrl: string; mode: CaptureMode }
  | { type: 'STOP_CAPTURE' };

const idleState: StoredCaptureState = {
  phase: 'idle',
  message: 'Ready to capture the active tab.',
  captureId: null,
  startedAt: null,
  mode: null,
  tabId: null,
  receiverOrigin: null,
  uploadId: null,
  nextSequence: 0,
};

let state: StoredCaptureState = idleState;
let activeCapture: ActiveCapture | null = null;
let uploadQueue: Promise<void> = Promise.resolve();
let uploadFailure: Error | null = null;

const stateReady = restoreState();

async function restoreState(): Promise<void> {
  const stored = await chrome.storage.session.get(STATE_KEY);
  const candidate = stored[STATE_KEY] as StoredCaptureState | undefined;
  if (candidate === undefined) {
    await persistState(idleState);
    return;
  }

  state = candidate;
  if (
    (candidate.phase === 'recording' || candidate.phase === 'stopping') &&
    candidate.tabId !== null &&
    candidate.receiverOrigin !== null &&
    candidate.uploadId !== null &&
    candidate.captureId !== null &&
    candidate.mode !== null &&
    candidate.startedAt !== null
  ) {
    activeCapture = {
      tabId: candidate.tabId,
      receiverOrigin: candidate.receiverOrigin,
      uploadId: candidate.uploadId,
      captureId: candidate.captureId,
      mode: candidate.mode,
      startedAt: candidate.startedAt,
      nextSequence: candidate.nextSequence,
      finalizing: false,
    };
  }
}

async function persistState(nextState: StoredCaptureState): Promise<void> {
  state = nextState;
  await chrome.storage.session.set({ [STATE_KEY]: nextState });
}

function publicState(): PublicCaptureState {
  return {
    phase: state.phase,
    message: state.message,
    captureId: state.captureId,
    startedAt: state.startedAt,
    mode: state.mode,
  };
}

function normalizeReceiverOrigin(value: string): string {
  const url = new URL(value || RECEIVER_DEFAULT);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

  if (
    url.protocol !== 'http:' ||
    !loopbackHosts.has(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Receiver must be an HTTP loopback origin without a path.');
  }

  return url.origin;
}

async function receiverRequest<T>(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  const body = (await response.json()) as T | ReceiverErrorResponse;

  if (!response.ok) {
    const receiverError = body as ReceiverErrorResponse;
    throw new Error(receiverError.error?.message ?? `Receiver returned HTTP ${response.status}.`);
  }

  return body as T;
}

async function checkReceiver(receiverUrl: string): Promise<{ origin: string }> {
  const origin = normalizeReceiverOrigin(receiverUrl);
  await receiverRequest<{ ok: true }>(origin, '/api/health');
  return { origin };
}

async function startCapture(receiverUrl: string, mode: CaptureMode): Promise<PublicCaptureState> {
  await stateReady;
  if (activeCapture !== null || ['starting', 'recording', 'stopping'].includes(state.phase)) {
    throw new Error('A trace capture is already active.');
  }
  if (mode !== 'authenticated-reload' && mode !== 'current-state-interaction') {
    throw new Error('Unsupported capture mode.');
  }

  const { origin } = await checkReceiver(receiverUrl);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.url === undefined) {
    throw new Error('No active browser tab is available.');
  }
  const pageUrl = new URL(tab.url);
  if (pageUrl.protocol !== 'http:' && pageUrl.protocol !== 'https:') {
    throw new Error('Only HTTP(S) pages can be captured.');
  }

  const startedAt = new Date().toISOString();
  await persistState({
    ...idleState,
    phase: 'starting',
    message: 'Connecting DevTools tracing to the active tab…',
    startedAt,
    mode,
    tabId: tab.id,
    receiverOrigin: origin,
  });

  let uploadId: string | null = null;
  let debuggerAttached = false;
  try {
    const started = await receiverRequest<ReceiverStartResponse>(origin, '/api/captures', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        source: 'rsdoctor-trace-extension',
        url: tab.url,
        title: tab.title ?? 'Untitled page',
        capturedAt: startedAt,
        cacheState: 'unknown',
        mode,
      }),
    });
    uploadId = started.uploadId;

    const target: chrome.debugger.Debuggee = { tabId: tab.id };
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    debuggerAttached = true;
    await chrome.debugger.sendCommand(target, 'Page.enable');
    await chrome.debugger.sendCommand(target, 'Tracing.start', {
      categories: TRACE_CATEGORIES,
      transferMode: 'ReportEvents',
      bufferUsageReportingInterval: 1_000,
    });

    activeCapture = {
      tabId: tab.id,
      receiverOrigin: origin,
      uploadId: started.uploadId,
      captureId: started.captureId,
      mode,
      startedAt,
      nextSequence: 0,
      finalizing: false,
    };
    uploadQueue = Promise.resolve();
    uploadFailure = null;

    await persistActiveState(
      activeCapture,
      'recording',
      mode === 'authenticated-reload'
        ? 'Recording a reload trace. Stop after the page settles.'
        : 'Recording. Reproduce the interaction, then stop.',
    );

    if (mode === 'authenticated-reload') {
      await chrome.debugger.sendCommand(target, 'Page.reload', { ignoreCache: false });
    }

    return publicState();
  } catch (error) {
    if (debuggerAttached) {
      await chrome.debugger.detach({ tabId: tab.id }).catch(() => undefined);
    }
    if (uploadId !== null) {
      await receiverRequest(origin, `/api/captures/${uploadId}/abort`, {
        method: 'POST',
      }).catch(() => undefined);
    }
    activeCapture = null;
    await persistState({
      ...idleState,
      phase: 'error',
      message: errorMessage(error),
      startedAt,
      mode,
    });
    throw error;
  }
}

async function persistActiveState(
  capture: ActiveCapture,
  phase: 'recording' | 'stopping',
  message: string,
): Promise<void> {
  await persistState({
    phase,
    message,
    captureId: capture.captureId,
    startedAt: capture.startedAt,
    mode: capture.mode,
    tabId: capture.tabId,
    receiverOrigin: capture.receiverOrigin,
    uploadId: capture.uploadId,
    nextSequence: capture.nextSequence,
  });
}

async function stopCapture(): Promise<PublicCaptureState> {
  await stateReady;
  const capture = activeCapture;
  if (capture === null) {
    throw new Error('No trace capture is active.');
  }
  if (capture.finalizing || state.phase === 'stopping') {
    return publicState();
  }

  await persistActiveState(capture, 'stopping', 'Finalizing trace chunks…');
  try {
    await chrome.debugger.sendCommand({ tabId: capture.tabId }, 'Tracing.end');
  } catch (error) {
    await failCapture(capture, error);
    throw error;
  }
  return publicState();
}

function enqueueTraceEvents(capture: ActiveCapture, traceEvents: unknown[]): void {
  if (traceEvents.length === 0 || uploadFailure !== null || capture.finalizing) {
    return;
  }

  const sequence = capture.nextSequence;
  capture.nextSequence += 1;
  uploadQueue = uploadQueue.then(async () => {
    if (uploadFailure !== null || activeCapture !== capture) {
      return;
    }
    try {
      await receiverRequest(capture.receiverOrigin, `/api/captures/${capture.uploadId}/chunks`, {
        method: 'POST',
        body: JSON.stringify({ sequence, traceEvents }),
      });
      await persistActiveState(capture, state.phase === 'stopping' ? 'stopping' : 'recording', state.message);
    } catch (error) {
      uploadFailure = error instanceof Error ? error : new Error(String(error));
      void stopAfterUploadFailure(capture);
    }
  });
}

async function stopAfterUploadFailure(capture: ActiveCapture): Promise<void> {
  if (activeCapture !== capture || capture.finalizing) {
    return;
  }
  await persistActiveState(capture, 'stopping', 'Trace upload failed; stopping capture…');
  await chrome.debugger
    .sendCommand({ tabId: capture.tabId }, 'Tracing.end')
    .catch((error) => failCapture(capture, error));
}

async function finalizeCapture(capture: ActiveCapture): Promise<void> {
  if (activeCapture !== capture || capture.finalizing) {
    return;
  }
  capture.finalizing = true;
  await uploadQueue;

  if (uploadFailure !== null) {
    await failCapture(capture, uploadFailure);
    return;
  }

  try {
    const completed = await receiverRequest<ReceiverCompleteResponse>(
      capture.receiverOrigin,
      `/api/captures/${capture.uploadId}/finish`,
      {
        method: 'POST',
        body: JSON.stringify({ lastSequence: capture.nextSequence - 1 }),
      },
    );

    activeCapture = null;
    await chrome.debugger.detach({ tabId: capture.tabId }).catch(() => undefined);
    await persistState({
      ...idleState,
      phase: 'completed',
      message: `Saved ${completed.traceEventCount.toLocaleString()} events to ${completed.trace}.`,
      captureId: completed.captureId,
      startedAt: capture.startedAt,
      mode: capture.mode,
    });
  } catch (error) {
    await failCapture(capture, error);
  }
}

async function failCapture(capture: ActiveCapture, error: unknown): Promise<void> {
  if (activeCapture !== capture) {
    return;
  }

  activeCapture = null;
  await receiverRequest(capture.receiverOrigin, `/api/captures/${capture.uploadId}/abort`, {
    method: 'POST',
  }).catch(() => undefined);
  await chrome.debugger.detach({ tabId: capture.tabId }).catch(() => undefined);
  await persistState({
    ...idleState,
    phase: 'error',
    message: errorMessage(error),
    captureId: capture.captureId,
    startedAt: capture.startedAt,
    mode: capture.mode,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  void stateReady.then(() => {
    const capture = activeCapture;
    if (capture === null || source.tabId !== capture.tabId) {
      return;
    }

    if (method === 'Tracing.dataCollected') {
      const traceEvents = (params as { value?: unknown[] } | undefined)?.value;
      if (Array.isArray(traceEvents)) {
        enqueueTraceEvents(capture, traceEvents);
      }
      return;
    }

    if (method === 'Tracing.tracingComplete') {
      void finalizeCapture(capture);
    }
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  void stateReady.then(() => {
    const capture = activeCapture;
    if (capture !== null && source.tabId === capture.tabId) {
      void failCapture(capture, new Error(`Debugger detached: ${reason}.`));
    }
  });
});

chrome.runtime.onMessage.addListener(
  (message: RequestMessage, _sender, sendResponse: (response: unknown) => void) => {
    void (async () => {
      await stateReady;
      switch (message.type) {
        case 'GET_STATE':
          return publicState();
        case 'CHECK_RECEIVER':
          return checkReceiver(message.receiverUrl);
        case 'START_CAPTURE':
          return startCapture(message.receiverUrl, message.mode);
        case 'STOP_CAPTURE':
          return stopCapture();
      }
    })()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));

    return true;
  },
);
