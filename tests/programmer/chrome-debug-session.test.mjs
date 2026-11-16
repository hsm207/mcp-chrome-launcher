import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.deepEqual(spec.args, ['--remote-debugging-port=9222', '--user-data-dir=C:\\temp\\chrome-dev-profile-test']);
    assert.equal(spec.options.detached, true);
    assert.equal(spec.options.stdio, 'ignore');
  });

  test('Given a real DevTools HTTP server, when waitForPort runs, then it resolves', async (t) => {
    const srv = await startRealDevToolsServer();
    t.after(() => srv.close());
    await waitForPort({ port: srv.port, timeoutMs: 2000, intervalMs: 50 });
  });

  test('Given an unused port, when waitForPort runs, then it rejects with timeout and port', async () => {
    await assert.rejects(() => waitForPort({ port: 19999, timeoutMs: 150, intervalMs: 50 }), /150ms.*19999/);
  });

  test('Given a real TCP listener on port, when diagnoseStartupFailure runs, then it reports port conflict', async (t) => {
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => server.close(r)));
    const { port } = server.address();
    const msg = await diagnoseStartupFailure({ port, userDataDir: os.tmpdir() });
    assert.match(msg, new RegExp(`Port ${port} is already in use`, 'i'));
  });

  test('Given a real profile lockfile, when diagnoseStartupFailure runs, then it reports profile lock', async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-lock-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, 'lockfile'), '');
    const msg = await diagnoseStartupFailure({ port: 19998, userDataDir: dir });
    assert.match(msg, /locked.*--remote-debugging-port=19998/i);
  });
});
