#!/usr/bin/env node

import { resolve } from 'node:path';
import { createTraceReceiver } from './server.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 43_119;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

interface CliOptions {
  host: string;
  port: number;
  rootDir: string;
}

function printHelp(): void {
  console.log(`rsdoctor-trace receiver

Usage:
  rsdoctor-trace [--root <workspace>] [--port <port>] [--host <loopback-host>]

Options:
  --root <path>  Workspace where .rsdoctor-performance is written (default: cwd)
  --port <port>  Loopback receiver port (default: ${DEFAULT_PORT})
  --host <host>  127.0.0.1, localhost, or ::1 (default: ${DEFAULT_HOST})
  --help         Show this help
`);
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseArgs(args: string[]): CliOptions | null {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let rootDir = process.cwd();

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--help' || option === '-h') {
      return null;
    }
    if (option === '--host') {
      host = readValue(args, index, option);
      index += 1;
      continue;
    }
    if (option === '--port') {
      port = Number(readValue(args, index, option));
      index += 1;
      continue;
    }
    if (option === '--root') {
      rootDir = resolve(readValue(args, index, option));
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${option}`);
  }

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('--host must be a loopback host: 127.0.0.1, localhost, or ::1.');
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be an integer between 1 and 65535.');
  }

  return { host, port, rootDir: resolve(rootDir) };
}

async function main(): Promise<void> {
  let options: CliOptions | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  if (options === null) {
    printHelp();
    return;
  }

  const server = createTraceReceiver({ rootDir: options.rootDir });
  server.on('error', (error) => {
    console.error(`Receiver failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(options.port, options.host, () => {
    console.log(`Rsdoctor Trace receiver: http://${options.host}:${options.port}`);
    console.log(`Artifacts: ${resolve(options.rootDir, '.rsdoctor-performance')}`);
    console.log('Press Ctrl+C to stop.');
  });

  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

await main();
