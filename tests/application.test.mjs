import { test as base, describe, expect } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import kill from 'tree-kill-promise';
import { isPortReady } from '../mcp-chrome-launcher.mjs';

const CLI_PATH = path.resolve('mcp-chrome-launcher.mjs');

const test = base.extend({
  tempDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-chrome-app-'));
    await use(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows Crashpad may briefly hold temp profile lock
    }
  },
  launcher: async ({ tempDir }, use) => {
    const children = [];
    const ports = [];
    const spawnLauncher = (port, extraArgs = []) => {
      if (port) ports.push(port);
      const child = execa(
        process.execPath,
        [CLI_PATH, `--port=${port}`, `--userDataDir=${tempDir}`, ...extraArgs],
        { reject: false, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' }
      );
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      children.push(child);
      return { child, getStderr: () => stderr };
    };

    await use(spawnLauncher);

    for (const port of ports) {
      await closeChromeOnPort(port);
    }
    for (const child of children) {
      child.stdin?.destroy();
      child.stderr?.destroy();
      if (child.pid && child.exitCode === null) {
        await kill(child.pid, 'SIGKILL').catch(() => {});
      }
    }
  },
});

describe('application: mcp-chrome-launcher CLI', () => {
  test('Given --version, when mcp-chrome-launcher runs, then it prints package version', async () => {
    const { exitCode, stdout } = await execa(process.execPath, [CLI_PATH, '--version'], { reject: false });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('Given --help, when mcp-chrome-launcher runs, then it prints usage options', async () => {
    const { exitCode, stdout } = await execa(process.execPath, [CLI_PATH, '--help'], { reject: false });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Usage: mcp-chrome-launcher/);
  });

  test('Given mcp-chrome-launcher over stdio, when tools/call arrives, then it lazy-launches real Chrome on the configured port', async ({ launcher }) => {
    const port = 19226;
    const { child } = launcher(port);

    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    expect(await isPortReady(port)).toBe(false);

    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_pages"}}\n');
    await expect.poll(() => isPortReady(port), { timeout: 12000, interval: 250 }).toBe(true);
  }, 15000);

  test('Given an occupied port, when tools/call arrives, then mcp-chrome-launcher logs port conflict to stderr', async ({ launcher }) => {
    const sockets = new Set();
    const blocker = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    });
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const { port } = blocker.address();

    try {
      const { child, getStderr } = launcher(port);
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_pages"}}\n');
      await expect.poll(getStderr, { timeout: 20000, interval: 250 }).toMatch(
        new RegExp(`Port ${port} is already in use`, 'i')
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => blocker.close(r));
    }
  }, 25000);
});

async function closeChromeOnPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl } = await res.json();
    if (!webSocketDebuggerUrl) return;
    await new Promise((resolve) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        ws.close();
        resolve();
      }, 1500);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      ws.addEventListener('close', done);
      ws.addEventListener('error', done);
    });
  } catch {
    // Port already closed
  }
}
