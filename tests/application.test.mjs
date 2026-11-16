import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildChromeSpawnSpec, isPortReady, waitForPort } from '../mcp-chrome-launcher.mjs';

/**
 * Application test: launches real Chrome with a temp profile and verifies DevTools HTTP readiness.
 */
test('Given a temp profile, when real Chrome launches on a debug port, then /json/version responds', async () => {
  const port = 19223;
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-chrome-app-test-'));
  const spec = buildChromeSpawnSpec({ port, userDataDir });
  const chrome = spawn(spec.command, [...spec.args, '--headless=new', '--no-sandbox'], {
    stdio: 'ignore',
  });

  try {
    await waitForPort({ port, timeoutMs: 15000, intervalMs: 250 });
    assert.equal(await isPortReady(port), true);
  } finally {
    chrome.kill('SIGTERM');
    await new Promise((resolve) => chrome.once('exit', resolve));
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
