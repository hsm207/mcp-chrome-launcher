import { describe, expect, onTestFinished, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  buildChromeSpawnSpec,
  diagnoseStartupFailure,
  waitForPort,
} from '../../mcp-chrome-launcher.mjs';

/**
 * Starts a real local HTTP server that responds 200 OK on `/json/version`.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function startRealDevToolsServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/json/version' ? 200 : 404);
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

describe('chrome-debug-session', () => {
  test('Given port and userDataDir, when buildChromeSpawnSpec runs, then it configures detached Chrome', () => {
    const spec = buildChromeSpawnSpec({ port: 9222, userDataDir: 'C:\\temp\\chrome-dev-profile-test' });
    expect(spec.args).toEqual(['--remote-debugging-port=9222', '--user-data-dir=C:\\temp\\chrome-dev-profile-test']);
    expect(spec.options.detached).toBe(true);
    expect(spec.options.stdio).toBe('ignore');
  });

  test('Given a real DevTools HTTP server, when waitForPort runs, then it resolves', async () => {
    const srv = await startRealDevToolsServer();
    onTestFinished(() => srv.close());
    await expect(waitForPort({ port: srv.port, timeoutMs: 2000, intervalMs: 50 })).resolves.toBeUndefined();
  });

  test('Given an unused port, when waitForPort runs, then it rejects with timeout and port', async () => {
    await expect(waitForPort({ port: 19999, timeoutMs: 150, intervalMs: 50 })).rejects.toThrow(/150ms.*19999/);
  });

  test('Given a real TCP listener on port, when diagnoseStartupFailure runs, then it reports port conflict', async () => {
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    onTestFinished(() => new Promise((r) => server.close(r)));
    const { port } = server.address();
    const msg = await diagnoseStartupFailure({ port, userDataDir: os.tmpdir() });
    expect(msg).toMatch(new RegExp(`Port ${port} is already in use`, 'i'));
  });

  test('Given a real profile lockfile, when diagnoseStartupFailure runs, then it reports profile lock', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-lock-test-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, 'lockfile'), '');
    const msg = await diagnoseStartupFailure({ port: 19998, userDataDir: dir });
    expect(msg).toMatch(/locked.*--remote-debugging-port=19998/i);
  });

  test('Given unused port and unlocked profile, when diagnoseStartupFailure runs, then it reports generic failure', async () => {
    const msg = await diagnoseStartupFailure({ port: 19997, userDataDir: os.tmpdir() });
    expect(msg).toMatch(/Chrome failed to expose DevTools on port 19997/i);
  });
});
