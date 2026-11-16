import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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
 * Builds deterministic stub dependencies and call-recording arrays for `launchAndRun` tests.
 * @param {{ port?: number, readyAfter?: number }} [opts]
 */
function createLaunchStubs({ port = 9223, readyAfter = 1 } = {}) {
  const events = [];
  const waits = [];
  let spawned = 0;
  let probeCalls = 0;
  let mcpOpts = null;

  return {
    events,
    waits,
    get spawned() { return spawned; },
    get mcpOpts() { return mcpOpts; },
    deps: {
      port,
      userDataDir: 'C:\\temp\\profile',
      spawnChrome: (cmd, args, opts) => {
        spawned++;
        events.push({ cmd, args, opts });
        return { unref: () => events.push('unref') };
      },
      probeFn: async () => ++probeCalls >= readyAfter,
      waitFn: async (ms) => { waits.push(ms); events.push(`wait:${ms}`); },
      runMcp: async (extraArgs, opts) => {
        mcpOpts = opts;
        events.push({ extraArgs, opts });
        return 0;
      },
    },
  };
}

describe('cli-options', () => {
  test('defaults userDataDir to ~/.chrome-dev-profile', () => {
    assert.equal(partitionArgs([]).userDataDir, path.join(os.homedir(), '.chrome-dev-profile'));
  });

  test('extracts --userDataDir= and forwards all other flags', () => {
    const result = partitionArgs(['--userDataDir=C:\\p', '--allowUnrestrictedPaths', '--logFile', 'C:\\a.log']);
    assert.equal(result.userDataDir, 'C:\\p');
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths', '--logFile', 'C:\\a.log']);
  });

  test('handles space-separated --userDataDir', () => {
    const result = partitionArgs(['--userDataDir', 'C:\\p', '--allowUnrestrictedPaths']);
    assert.equal(result.userDataDir, 'C:\\p');
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
  });

  test('defaults port to 9223', () => {
    assert.equal(partitionArgs([]).port, 9223);
  });

  test('extracts --port=9225', () => {
    const result = partitionArgs(['--port=9225', '--allowUnrestrictedPaths']);
    assert.equal(result.port, 9225);
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
  });

  test('handles space-separated --port', () => {
    assert.equal(partitionArgs(['--port', '9226']).port, 9226);
  });

  test('throws on invalid --port', () => {
    assert.throws(() => partitionArgs(['--port=abc']), /Invalid --port/i);
  });

  test('defaults chromePath to null', () => {
    assert.equal(partitionArgs([]).chromePath, null);
  });

  test('extracts --chromePath=', () => {
    const result = partitionArgs(['--chromePath=/custom/chrome', '--allowUnrestrictedPaths']);
    assert.equal(result.chromePath, '/custom/chrome');
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
  });

  test('handles space-separated --chromePath', () => {
    assert.equal(partitionArgs(['--chromePath', '/custom/chrome']).chromePath, '/custom/chrome');
  });

  test('detects --help and -h flags', () => {
    assert.equal(partitionArgs(['--help']).help, true);
    assert.equal(partitionArgs(['-h']).help, true);
  });

  test('detects --version and -v flags', () => {
    assert.equal(partitionArgs(['--version']).version, true);
    assert.equal(partitionArgs(['-v']).version, true);
  });
});

describe('chrome-discovery', () => {
  test('discovers Chrome on win32', () => {
    const win = findChromePath({
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files' },
      existsSync: (p) => p === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    assert.equal(win, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  });

  test('discovers Chrome on darwin', () => {
    const mac = findChromePath({
      platform: 'darwin',
      env: { HOME: '/Users/dev' },
      existsSync: (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    assert.equal(mac, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  test('discovers Chrome on linux', () => {
    const linux = findChromePath({
      platform: 'linux',
      env: {},
      existsSync: (p) => p === '/usr/bin/google-chrome',
    });
    assert.equal(linux, '/usr/bin/google-chrome');
  });

  test('throws agent-friendly error when no Chrome is found', () => {
    assert.throws(
      () => findChromePath({ platform: 'linux', env: {}, existsSync: () => false }),
      /Chrome executable not found.*--chromePath=<path>/s
    );
  });
});

describe('chrome-debug-session', () => {
  test('buildChromeSpawnSpec configures detached Chrome on 9222 with userDataDir', () => {
    const spec = buildChromeSpawnSpec({ port: 9222, userDataDir: 'C:\\temp\\chrome-dev-profile-test' });
    assert.deepEqual(spec.args, ['--remote-debugging-port=9222', '--user-data-dir=C:\\temp\\chrome-dev-profile-test']);
    assert.equal(spec.options.detached, true);
    assert.equal(spec.options.stdio, 'ignore');
  });

  test('waitForPort resolves once probeFn returns true', async () => {
    let calls = 0;
    const waits = [];
    await waitForPort({ port: 9223, probeFn: async () => ++calls >= 3, waitFn: async (ms) => waits.push(ms), timeoutMs: 1000, intervalMs: 200 });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [200, 200]);
  });

  test('waitForPort rejects with port and timeout when probeFn never succeeds', async () => {
    await assert.rejects(
      () => waitForPort({ port: 9223, probeFn: async () => false, waitFn: async () => {}, timeoutMs: 400, intervalMs: 200 }),
      /400ms.*9223/
    );
  });

  test('diagnoseStartupFailure reports port conflict when port is occupied', async () => {
    const msg = await diagnoseStartupFailure({ port: 9223, userDataDir: 'C:\\temp\\profile', portOccupiedFn: async () => true, lockExistsFn: () => false });
    assert.match(msg, /Port 9223 is already in use/i);
  });

  test('diagnoseStartupFailure reports profile lock when lockfile exists without debug port', async () => {
    const msg = await diagnoseStartupFailure({ port: 9223, userDataDir: 'C:\\temp\\profile', portOccupiedFn: async () => false, lockExistsFn: () => true });
    assert.match(msg, /locked.*--remote-debugging-port=9223/i);
  });
});

describe('mcp-stdio-bridge', () => {
  test('buildMcpSpawnSpec defaults to npx chrome-devtools-mcp@latest with inherited stdio', () => {
    const spec = buildMcpSpawnSpec([]);
    assert.equal(spec.command, 'npx');
    assert.deepEqual(spec.args, ['-y', 'chrome-devtools-mcp@latest']);
    assert.equal(spec.options.stdio, 'inherit');
    assert.equal(spec.options.shell, process.platform === 'win32');
  });

  test('buildMcpSpawnSpec forwards caller args after package name', () => {
    const spec = buildMcpSpawnSpec(['--allowUnrestrictedPaths', '--categoryExtensions']);
    assert.deepEqual(spec.args, ['-y', 'chrome-devtools-mcp@latest', '--allowUnrestrictedPaths', '--categoryExtensions']);
  });

  test('buildMcpSpawnSpec includes --browserUrl when provided', () => {
    const spec = buildMcpSpawnSpec(['--allowUnrestrictedPaths'], { browserUrl: 'http://127.0.0.1:9222' });
    assert.deepEqual(spec.args, ['-y', 'chrome-devtools-mcp@latest', '--browserUrl=http://127.0.0.1:9222', '--allowUnrestrictedPaths']);
  });

  test('runPassthrough preserves child exit code without polluting stdout', async () => {
    const code = await runPassthrough([], () => ({ command: process.execPath, args: ['-e', 'process.exit(0)'], options: { stdio: 'inherit' } }));
    assert.equal(code, 0);
  });

  test('runPassthrough forwards non-zero child exit code', async () => {
    const code = await runPassthrough([], () => ({ command: process.execPath, args: ['-e', 'process.exit(42)'], options: { stdio: 'inherit' } }));
    assert.equal(code, 42);
  });

  test('launchAndRun spawns detached Chrome, unrefs, waits, and runs MCP with browserUrl', async () => {
    const stub = createLaunchStubs({ port: 9222, readyAfter: 2 });
    const code = await launchAndRun(['--allowUnrestrictedPaths'], stub.deps);
    assert.equal(code, 0);
    assert.equal(stub.events[1], 'unref');
    assert.deepEqual(stub.events[2], { extraArgs: ['--allowUnrestrictedPaths'], opts: { browserUrl: 'http://127.0.0.1:9222' } });
  });

  test('launchAndRun skips spawning and waiting when port is already ready', async () => {
    const stub = createLaunchStubs({ port: 9223, readyAfter: 1 });
    const code = await launchAndRun(['--allowUnrestrictedPaths'], stub.deps);
    assert.equal(code, 0);
    assert.equal(stub.spawned, 0);
    assert.deepEqual(stub.waits, []);
    assert.deepEqual(stub.mcpOpts, { browserUrl: 'http://127.0.0.1:9223' });
  });

  test('launchAndRun spawns Chrome once when port is not initially ready', async () => {
    const stub = createLaunchStubs({ port: 9223, readyAfter: 2 });
    const code = await launchAndRun([], stub.deps);
    assert.equal(code, 0);
    assert.equal(stub.spawned, 1);
  });

  test('wireLifecycle forwards SIGTERM to child and cleans up listeners', () => {
    const fakeProc = new EventEmitter();
    const killed = [];
    const detach = wireLifecycle({ kill: (sig) => killed.push(sig) }, fakeProc);
    fakeProc.emit('SIGTERM');
    detach();
    fakeProc.emit('SIGTERM');
    assert.deepEqual(killed, ['SIGTERM']);
  });

  test('isToolCallMessage returns true for tools/call JSON-RPC messages', () => {
    assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{}}\n'), true);
  });

  test('isToolCallMessage returns false for non-tools/call JSON-RPC messages', () => {
    assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'), false);
    assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'), false);
  });
});
