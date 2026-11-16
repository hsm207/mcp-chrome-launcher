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
  test('Given win32, when findChromePath runs, then it discovers Chrome in Program Files', () => {
    const win = findChromePath({
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files' },
      existsSync: (p) => p === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
    assert.equal(win, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  });

  test('Given darwin, when findChromePath runs, then it discovers Chrome in /Applications', () => {
    const mac = findChromePath({
      platform: 'darwin',
      env: { HOME: '/Users/dev' },
      existsSync: (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    assert.equal(mac, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  test('Given linux, when findChromePath runs, then it discovers google-chrome in /usr/bin', () => {
    const linux = findChromePath({
      platform: 'linux',
      env: {},
      existsSync: (p) => p === '/usr/bin/google-chrome',
    });
    assert.equal(linux, '/usr/bin/google-chrome');
  });

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

  test('Given probeFn succeeds on 3rd attempt, when waitForPort runs, then it resolves after 2 waits', async () => {
    let calls = 0;
    const waits = [];
    await waitForPort({ port: 9223, probeFn: async () => ++calls >= 3, waitFn: async (ms) => waits.push(ms), timeoutMs: 1000, intervalMs: 200 });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [200, 200]);
  });

  test('Given probeFn never succeeds, when waitForPort runs, then it rejects with timeout and port', async () => {
    await assert.rejects(
      () => waitForPort({ port: 9223, probeFn: async () => false, waitFn: async () => {}, timeoutMs: 400, intervalMs: 200 }),
      /400ms.*9223/
    );
  });

  test('Given port is occupied, when diagnoseStartupFailure runs, then it reports port conflict', async () => {
    const msg = await diagnoseStartupFailure({ port: 9223, userDataDir: 'C:\\temp\\profile', portOccupiedFn: async () => true, lockExistsFn: () => false });
    assert.match(msg, /Port 9223 is already in use/i);
  });

  test('Given profile lock exists, when diagnoseStartupFailure runs, then it reports profile lock', async () => {
    const msg = await diagnoseStartupFailure({ port: 9223, userDataDir: 'C:\\temp\\profile', portOccupiedFn: async () => false, lockExistsFn: () => true });
    assert.match(msg, /locked.*--remote-debugging-port=9223/i);
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

  test('Given port not ready, when launchAndRun runs, then it spawns detached Chrome once, unrefs, and runs MCP', async () => {
    const stub = createLaunchStubs({ port: 9222, readyAfter: 2 });
    const code = await launchAndRun(['--allowUnrestrictedPaths'], stub.deps);
    assert.equal(code, 0);
    assert.equal(stub.spawned, 1);
    assert.equal(stub.events[1], 'unref');
    assert.deepEqual(stub.events[2], { extraArgs: ['--allowUnrestrictedPaths'], opts: { browserUrl: 'http://127.0.0.1:9222' } });
  });

  test('Given port already ready, when launchAndRun runs, then it skips spawning and waiting', async () => {
    const stub = createLaunchStubs({ port: 9223, readyAfter: 1 });
    const code = await launchAndRun(['--allowUnrestrictedPaths'], stub.deps);
    assert.equal(code, 0);
    assert.equal(stub.spawned, 0);
    assert.deepEqual(stub.waits, []);
    assert.deepEqual(stub.mcpOpts, { browserUrl: 'http://127.0.0.1:9223' });
  });

  test('Given SIGTERM, when wireLifecycle is attached, then it forwards SIGTERM and cleans up after detach', () => {
    const fakeProc = new EventEmitter();
    const killed = [];
    const detach = wireLifecycle({ kill: (sig) => killed.push(sig) }, fakeProc);
    fakeProc.emit('SIGTERM');
    detach();
    fakeProc.emit('SIGTERM');
    assert.deepEqual(killed, ['SIGTERM']);
  });

  test('Given tools/call JSON-RPC chunk, when isToolCallMessage runs, then it returns true', () => {
    assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{}}\n'), true);
  });

  test('Given initialize or tools/list chunk, when isToolCallMessage runs, then it returns false', () => {
    assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'), false);
    assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'), false);
  });
});
