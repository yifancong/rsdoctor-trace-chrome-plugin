export {};

const RECEIVER_KEY = 'rsdoctorTraceReceiverUrl';
const DEFAULT_RECEIVER = 'http://127.0.0.1:43119';

type CapturePhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'error';
type CaptureMode = 'authenticated-reload' | 'current-state-interaction';

interface CaptureState {
  phase: CapturePhase;
  message: string;
  captureId: string | null;
  startedAt: string | null;
  mode: CaptureMode | null;
}

interface MessageResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function element<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) {
    throw new Error(`Missing popup element: ${selector}`);
  }
  return value;
}

const receiverInput = element<HTMLInputElement>('#receiver-url');
const receiverStatus = element<HTMLParagraphElement>('#receiver-status');
const checkButton = element<HTMLButtonElement>('#check-receiver');
const startButton = element<HTMLButtonElement>('#start');
const stopButton = element<HTMLButtonElement>('#stop');
const phaseLabel = element<HTMLSpanElement>('#phase');
const messageLabel = element<HTMLParagraphElement>('#message');
const captureIdLabel = element<HTMLElement>('#capture-id');
const statusDot = element<HTMLSpanElement>('#status-dot');

async function send<T>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as MessageResponse<T>;
  if (!response.ok || response.data === undefined) {
    throw new Error(response.error ?? 'The extension did not return a response.');
  }
  return response.data;
}

function selectedMode(): CaptureMode {
  const selected = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return selected?.value === 'current-state-interaction'
    ? 'current-state-interaction'
    : 'authenticated-reload';
}

function render(state: CaptureState): void {
  const active = ['starting', 'recording', 'stopping'].includes(state.phase);
  phaseLabel.textContent = state.phase;
  messageLabel.textContent = state.message;
  captureIdLabel.textContent = state.captureId ?? '';
  captureIdLabel.hidden = state.captureId === null;
  startButton.disabled = active;
  stopButton.disabled = state.phase !== 'recording';
  receiverInput.disabled = active;
  checkButton.disabled = active;
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    input.disabled = active;
  }

  statusDot.className = 'status-dot';
  if (state.phase === 'recording' || state.phase === 'starting' || state.phase === 'stopping') {
    statusDot.classList.add('recording');
  } else if (state.phase === 'completed') {
    statusDot.classList.add('completed');
  } else if (state.phase === 'error') {
    statusDot.classList.add('error');
  }
}

async function refresh(): Promise<void> {
  render(await send<CaptureState>({ type: 'GET_STATE' }));
}

async function checkReceiver(): Promise<void> {
  checkButton.disabled = true;
  receiverStatus.textContent = 'Checking receiver…';
  try {
    const result = await send<{ origin: string }>({
      type: 'CHECK_RECEIVER',
      receiverUrl: receiverInput.value,
    });
    receiverStatus.textContent = `Connected to ${result.origin}.`;
  } catch (error) {
    receiverStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    checkButton.disabled = false;
  }
}

checkButton.addEventListener('click', () => void checkReceiver());

receiverInput.addEventListener('change', () => {
  void chrome.storage.local.set({ [RECEIVER_KEY]: receiverInput.value.trim() });
});

startButton.addEventListener('click', () => {
  void (async () => {
    startButton.disabled = true;
    await chrome.storage.local.set({ [RECEIVER_KEY]: receiverInput.value.trim() });
    try {
      render(
        await send<CaptureState>({
          type: 'START_CAPTURE',
          receiverUrl: receiverInput.value,
          mode: selectedMode(),
        }),
      );
    } catch (error) {
      messageLabel.textContent = error instanceof Error ? error.message : String(error);
      statusDot.className = 'status-dot error';
      await refresh().catch(() => undefined);
    }
  })();
});

stopButton.addEventListener('click', () => {
  void (async () => {
    stopButton.disabled = true;
    try {
      render(await send<CaptureState>({ type: 'STOP_CAPTURE' }));
    } catch (error) {
      messageLabel.textContent = error instanceof Error ? error.message : String(error);
    }
  })();
});

void (async () => {
  const stored = await chrome.storage.local.get(RECEIVER_KEY);
  receiverInput.value =
    typeof stored[RECEIVER_KEY] === 'string' ? stored[RECEIVER_KEY] : DEFAULT_RECEIVER;
  await refresh();
  window.setInterval(() => void refresh().catch(() => undefined), 750);
})();
