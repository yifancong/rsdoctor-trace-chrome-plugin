import { cp, mkdir, rm } from 'node:fs/promises';

const extensionRoot = new URL('../packages/extension/', import.meta.url);
const dist = new URL('dist/', extensionRoot);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(new URL('build/', extensionRoot), dist, { recursive: true });
await cp(new URL('static/', extensionRoot), dist, { recursive: true });
