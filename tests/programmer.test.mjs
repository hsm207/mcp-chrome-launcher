import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  buildChromeSpawnSpec,
  buildMcpSpawnSpec,
  diagnoseStartupFailure,
  findChromePath,
  isToolCallMessage,
  launchAndRun,
  partitionArgs,
  runPassthrough,
  waitForPort,
  wireLifecycle,
} from '../mcp-chrome-launcher.mjs';

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

describe('cli-options', () => {
  test('Given no args, when partitionArgs runs, then userDataDir defaults to ~/.chrome-dev-profile', () => {
    assert.equal(partitionArgs([]).userDataDir, path.join(os.homedir(), '.chrome-dev-profile'));
  });

  test('Given --userDataDir=, when partitionArgs runs, then it extracts userDataDir and forwards remaining flags', () => {
    const result = partitionArgs(['--userDataDir=C:\\p', '--allowUnrestrictedPaths', '--logFile', 'C:\\a.log']);
    assert.equal(result.userDataDir, 'C:\\p');
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths', '--logFile', 'C:\\a.log']);
  });

  test('Given space-separated --userDataDir, when partitionArgs runs, then it extracts userDataDir', () => {
    const result = partitionArgs(['--userDataDir', 'C:\\p', '--allowUnrestrictedPaths']);
    assert.equal(result.userDataDir, 'C:\\p');
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
  });

  test('Given no args, when partitionArgs runs, then port defaults to 9223', () => {
    assert.equal(partitionArgs([]).port, 9223);
  });

  test('Given --port=9225, when partitionArgs runs, then it extracts port 9225 and forwards remaining flags', () => {
    const result = partitionArgs(['--port=9225', '--allowUnrestrictedPaths']);
    assert.equal(result.port, 9225);
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
  });

  test('Given space-separated --port, when partitionArgs runs, then it extracts port', () => {
    assert.equal(partitionArgs(['--port', '9226']).port, 9226);
  });

  test('Given invalid --port, when partitionArgs runs, then it throws an error', () => {
    assert.throws(() => partitionArgs(['--port=abc']), /Invalid --port/i);
  });

  test('Given no args, when partitionArgs runs, then chromePath defaults to null', () => {
    assert.equal(partitionArgs([]).chromePath, null);
  });

  test('Given --chromePath=, when partitionArgs runs, then it extracts chromePath and forwards remaining flags', () => {
    const result = partitionArgs(['--chromePath=/custom/chrome', '--allowUnrestrictedPaths']);
    assert.equal(result.chromePath, '/custom/chrome');
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
  });

  test('Given space-separated --chromePath, when partitionArgs runs, then it extracts chromePath', () => {
    assert.equal(partitionArgs(['--chromePath', '/custom/chrome']).chromePath, '/custom/chrome');
  });

  test('Given --help or -h, when partitionArgs runs, then help is true', () => {
    assert.equal(partitionArgs(['--help']).help, true);
    assert.equal(partitionArgs(['-h']).help, true);
  });

  test('Given --version or -v, when partitionArgs runs, then version is true', () => {
    assert.equal(partitionArgs(['--version']).version, true);
    assert.equal(partitionArgs(['-v']).version, true);
  });
});

describe('chrome-discovery', () => {
  test('Given no Chrome binary on disk, when findChromePath runs, then it throws an agent-friendly error', () => {
    assert.throws(
      () => findChromePath({ platform: 'linux', env: {}, existsSync: () => false }),
      /Chrome executable not found.*--chromePath=<path>/s
    );
  });
});

describe('chrome-debug-session', () => {
  test('Given port and userDataDir, when buildChromeSpawnSpec runs, then it configures detached Chrome', () => {
    const spec = buildChromeSpawnSpec({ port: 9222, userDataDir: 'C:\\temp\\chrome-dev-profile-test' });
    assert.deepEqual(spec.args, ['--remote-debugging-port=9222', '--user-data-dir=C:\\temp\\chrome-dev-profile-test']);
    assert.equal(spec.options.detached, true);
    assert.equal(spec.options.stdio, 'ignore');
  });

  test('Given a real DevTools HTTP server, when waitForPort runs, then it resolves', async () => {
    const srv = await startRealDevToolsServer();
    try {
      await waitForPort({ port: srv.port, timeoutMs: 2000, intervalMs: 50 });
    } finally {
      await srv.close();
    }
  });

  test('Given an unused port, when waitForPort runs, then it rejects with timeout and port', async () => {
    await assert.rejects(() => waitForPort({ port: 19999, timeoutMs: 150, intervalMs: 50 }), /150ms.*19999/);
  });

  test('Given a real TCP listener on port, when diagnoseStartupFailure runs, then it reports port conflict', async () => {
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const msg = await diagnoseStartupFailure({ port, userDataDir: os.tmpdir() });
      assert.match(msg, new RegExp(`Port ${port} is already in use`, 'i'));
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('Given a real profile lockfile, when diagnoseStartupFailure runs, then it reports profile lock', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-lock-test-'));
    writeFileSync(path.join(dir, 'lockfile'), '');
    try {
      const msg = await diagnoseStartupFailure({ port: 19998, userDataDir: dir });
      assert.match(msg, /locked.*--remote-debugging-port=19998/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mcp-stdio-bridge', () => {
  test('Given no args, when buildMcpSpawnSpec runs, then it defaults to npx chrome-devtools-mcp@latest', () => {
    const spec = buildMcpSpawnSpec([]);
    assert.equal(spec.command, 'npx');
    assert.deepEqual(spec.args, ['-y', 'chrome-devtools-mcp@latest']);
    assert.equal(spec.options.stdio, 'inherit');
    assert.equal(spec.options.shell, process.platform === 'win32');
  });

  test('Given caller args, when buildMcpSpawnSpec runs, then it forwards them after package name', () => {
    const spec = buildMcpSpawnSpec(['--allowUnrestrictedPaths', '--categoryExtensions']);
    assert.deepEqual(spec.args, ['-y', 'chrome-devtools-mcp@latest', '--allowUnrestrictedPaths', '--categoryExtensions']);
  });

  test('Given browserUrl, when buildMcpSpawnSpec runs, then it includes --browserUrl', () => {
    const spec = buildMcpSpawnSpec(['--allowUnrestrictedPaths'], { browserUrl: 'http://127.0.0.1:9222' });
    assert.deepEqual(spec.args, ['-y', 'chrome-devtools-mcp@latest', '--browserUrl=http://127.0.0.1:9222', '--allowUnrestrictedPaths']);
  });

  test('Given child exits 0, when runPassthrough runs, then it resolves with 0', async () => {
    const code = await runPassthrough([], () => ({ command: process.execPath, args: ['-e', 'process.exit(0)'], options: { stdio: 'inherit' } }));
    assert.equal(code, 0);
  });

  test('Given child exits 42, when runPassthrough runs, then it forwards exit code 42', async () => {
    const code = await runPassthrough([], () => ({ command: process.execPath, args: ['-e', 'process.exit(42)'], options: { stdio: 'inherit' } }));
    assert.equal(code, 42);
  });

  test('Given a real DevTools server on port, when launchAndRun runs, then it passes browserUrl to runMcp', async () => {
    const srv = await startRealDevToolsServer();
    try {
      const code = await launchAndRun(['--allowUnrestrictedPaths'], {
        port: srv.port,
        runMcp: async (args, opts) => {
          assert.deepEqual(args, ['--allowUnrestrictedPaths']);
          assert.deepEqual(opts, { browserUrl: `http://127.0.0.1:${srv.port}` });
          return 0;
        },
      });
      assert.equal(code, 0);
    } finally {
      await srv.close();
    }
  });

  test('Given a real child process, when wireLifecycle detaches, then listener count returns to baseline', () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    const before = process.listenerCount('SIGTERM');
    const detach = wireLifecycle(child);
    assert.equal(process.listenerCount('SIGTERM'), before + 1);
    detach();
    assert.equal(process.listenerCount('SIGTERM'), before);
    child.kill();
  });

  test('Given tools/call JSON-RPC chunk, when isToolCallMessage runs, then it returns true', () => {
    assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{}}\n'), true);
  });

  test('Given initialize or tools/list chunk, when isToolCallMessage runs, then it returns false', () => {
    assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'), false);
    assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'), false);
  });
});
