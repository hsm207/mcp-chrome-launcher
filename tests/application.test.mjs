import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPortReady, waitForPort } from '../mcp-chrome-launcher.mjs';

const CLI_PATH = path.resolve('mcp-chrome-launcher.mjs');

describe('application: mcp-chrome-launcher CLI', () => {
  test('Given --version, when mcp-chrome-launcher runs, then it prints package version', () => {
    const out = execFileSync(process.execPath, [CLI_PATH, '--version'], { encoding: 'utf8' });
    assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
  });

  test('Given --help, when mcp-chrome-launcher runs, then it prints usage options', () => {
    const out = execFileSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
    assert.match(out, /Usage: mcp-chrome-launcher/);
  });

  test('Given mcp-chrome-launcher over stdio, when tools/call arrives, then it lazy-launches real Chrome on the configured port', async (t) => {
    const port = 19225;
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-chrome-app-test-'));
    const launcher = spawn(process.execPath, [CLI_PATH, `--port=${port}`, `--userDataDir=${userDataDir}`], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    t.after(async () => {
      killProcessTree(launcher);
      await killChromeOnPort(port);
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    launcher.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    assert.equal(await isPortReady(port), false);

    launcher.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_pages"}}\n');
    await waitForPort({ port, timeoutMs: 15000, intervalMs: 250 });
    assert.equal(await isPortReady(port), true);
  });
});

function killProcessTree(child) {
  try {
    child.stdin.end();
    if (process.platform === 'win32' && child.pid) {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // Process already exited
  }
}

async function killChromeOnPort(port) {
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
