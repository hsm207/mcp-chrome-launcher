import { test as base } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import kill from 'tree-kill-promise';

export const CLI_PATH = path.resolve('mcp-chrome-launcher.mjs');

/**
 * Extended Vitest `test` with isolated `tempDir`, `launcher`, and `occupiedPort` fixtures.
 */
export const test = base.extend({
  tempDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-chrome-app-'));
    await use(dir);
    cleanupTempDir(dir);
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
        { reject: false, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' }
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

async function cleanupLauncherResources(ports, children) {
  for (const port of ports) {
    await closeChromeOnPort(port);
  }
  for (const child of children) {
    await terminateChild(child);
  }
}

async function terminateChild(child) {
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
