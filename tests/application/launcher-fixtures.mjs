import { test as base } from 'vitest';
import { execa } from 'execa';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import kill from 'tree-kill-promise';

export const CLI_PATH = path.resolve('mcp-chrome-launcher.mjs');

/**
 * The launcher spawns `npx chrome-devtools-mcp@latest` as its MCP child. On CI that
 * install is slow, collides in npx's shared cache (`ENOTEMPTY` on reruns), and a child
 * that never exits leaves the launcher — and its V8 coverage flush — hanging. These
 * tests only exercise the launcher, so PATH points at a stub that idles until stdin
 * closes and then exits.
 */
const NPX_STUB_DIR = createNpxStub();

/**
 * Extended Vitest `test` with isolated `tempDir`, `freePort`, `launcher`, and
 * `occupiedPort` fixtures.
 */
export const test = base.extend({
  tempDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-chrome-app-'));
    await use(dir);
    cleanupTempDir(dir);
  },
  freePort: async ({}, use) => {
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address();
    await new Promise((r) => probe.close(r));
    await use(port);
  },
  launcher: async ({ tempDir }, use) => {
    const tracker = createLauncherTracker(tempDir);
    await use(tracker.spawn);
    await tracker.cleanup();
  },
  occupiedPort: async ({}, use) => {
    const { blocker, sockets } = await startOccupiedPortServer();
    await use(blocker.address().port);
    await closeOccupiedPortServer(blocker, sockets);
  },
});

function createNpxStub() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-npx-stub-'));
  const stub = path.join(dir, 'mcpserver.mjs');
  writeFileSync(stub, "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n");
  const posixShim = path.join(dir, 'npx');
  writeFileSync(posixShim, `#!/bin/sh\nexec "${process.execPath}" "${stub}"\n`);
  chmodSync(posixShim, 0o755);
  writeFileSync(path.join(dir, 'npx.cmd'), `@"${process.execPath}" "${stub}" %*\r\n`);
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withStubNpx(env = process.env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];
  const prefix = current ? `${NPX_STUB_DIR}${path.delimiter}${current}` : NPX_STUB_DIR;
  return { ...env, [key]: prefix };
}

function cleanupTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows Crashpad may briefly hold temp profile lock
  }
}

function createLauncherTracker(tempDir) {
  const children = [];
  const ports = [];
  let nextId = 1;

  return {
    spawn: (port, extraArgs = []) => {
      if (port) ports.push(port);
      const child = execa(
        process.execPath,
        [CLI_PATH, `--port=${port}`, `--userDataDir=${tempDir}`, ...extraArgs],
        { reject: false, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe', env: withStubNpx() }
      );
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      children.push(child);
      const sendRpc = (method, params = {}) =>
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })}\n`);
      return { child, sendRpc, getStderr: () => stderr };
    },
    cleanup: () => cleanupLauncherResources(ports, children),
  };
}

// Children first: a still-running launcher could spawn a fresh detached Chrome after
// the port cleanup already ran, leaving that browser orphaned on the debug port.
async function cleanupLauncherResources(ports, children) {
  for (const child of children) {
    await terminateChild(child);
  }
  for (const port of ports) {
    await closeChromeOnPort(port);
  }
}

async function terminateChild(child) {
  child.stdin?.end();
  await Promise.race([child.catch(() => {}), delay(1000)]);
  child.stdin?.destroy();
  child.stderr?.destroy();
  if (child.pid && child.exitCode === null) {
    await kill(child.pid, 'SIGKILL').catch(() => {});
  }
}

async function startOccupiedPortServer() {
  const sockets = new Set();
  const blocker = net.createServer((socket) => trackAndRejectSocket(socket, sockets));
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  return { blocker, sockets };
}

function trackAndRejectSocket(socket, sockets) {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
}

function closeOccupiedPortServer(blocker, sockets) {
  for (const socket of sockets) socket.destroy();
  return new Promise((r) => blocker.close(r));
}

async function closeChromeOnPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl } = await res.json();
    if (webSocketDebuggerUrl) await sendBrowserClose(webSocketDebuggerUrl);
  } catch {
    // Port already closed
  }
}

function sendBrowserClose(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); resolve(); }, 1500);
    const done = () => { clearTimeout(timer); resolve(); };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
    ws.addEventListener('close', done);
    ws.addEventListener('error', done);
  });
}
