# Rsdoctor Trace

Rsdoctor Trace captures raw Chrome performance trace events from the user's current authenticated tab and saves them locally for `rsdoctor-performance-analyze`.

The project has two deliberately small parts:

- A Manifest V3 Chrome extension that controls Chrome DevTools tracing.
- A zero-runtime-dependency Node.js receiver that writes trace artifacts into the target workspace.

It does not analyze traces or bundles. The companion skill owns normalization, diagnosis, and any optional handoff to `rsdoctor-analysis`.

## Requirements

- Node.js 20 or newer
- pnpm 9
- Chrome 116 or newer

## Build

```bash
pnpm install
pnpm build
pnpm test
```

The unpacked extension is generated at `packages/extension/dist`.

## Use

1. Start the receiver from the workspace whose page you want to analyze:

   ```bash
   pnpm receiver --root /path/to/workspace
   ```

2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `packages/extension/dist`.
3. Open and authenticate the target page in the normal browser session.
4. Open Rsdoctor Trace, verify the local receiver, select a mode, and start capturing.
5. Stop after the reload settles or after reproducing the target interaction.

The default receiver is `http://127.0.0.1:43119`. A different loopback port can be selected on both sides:

```bash
pnpm receiver --port 43120 --root /path/to/workspace
```

## Artifacts

A successful capture produces:

```text
.rsdoctor-performance/
  latest.json
  <YYYYMMDD-HHMMSS>-<host>/
    manifest.json
    trace.json
```

`latest.json` follows the `rsdoctor-performance-analyze` automation contract. Downstream summary and diagnosis fields remain `null` until the skill produces those artifacts. The receiver updates `latest.json` only after all trace chunks and the capture manifest are safely written.

## Capture modes

- **Reload page** starts tracing and reloads the active authenticated tab. Use it for page-load vitals, main-thread work, and network waterfalls.
- **Current state** starts tracing without navigation. Use it for an interaction that must happen after load.

Chrome displays its standard debugger warning while capture is active. Stopping the capture detaches the debugger.

## Privacy and safety

- The receiver accepts only loopback hosts and the extension accepts only loopback HTTP endpoints.
- Browser requests must originate from a Chrome extension; ordinary webpage origins are rejected.
- The extension does not read or transmit cookies, headers, local/session storage, request bodies, response bodies, or user identifiers.
- Sensitive query parameters are redacted and URL fragments are removed before manifests are written.
- Raw trace events can still contain page URLs and browser-observed runtime data. Keep `.rsdoctor-performance` local and review artifacts before sharing them.

## Receiver protocol

The receiver exposes:

- `GET /api/health`
- `POST /api/captures` to start a streamed capture, or to save a complete `traceEvents` array in one request
- `POST /api/captures/:uploadId/chunks`
- `POST /api/captures/:uploadId/finish`
- `POST /api/captures/:uploadId/abort`

Each JSON request is bounded to 32 MiB. Trace chunks are staged separately and combined in sequence without holding the complete trace in memory.
