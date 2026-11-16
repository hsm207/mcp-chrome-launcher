import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildChromeSpawnSpec,
  buildMcpSpawnSpec,
  diagnoseStartupFailure,
  launchAndRun,
  partitionArgs,
  runPassthrough,
  waitForPort,
  wireLifecycle,
} from './mcp-chrome-launcher.mjs';

test('Test 1: buildMcpSpawnSpec defaults to npx chrome-devtools-mcp@latest with inherited stdio', () => {
  const spec = buildMcpSpawnSpec([]);

  assert.equal(spec.command, 'npx');
  assert.deepEqual(spec.args, ['-y', 'chrome-devtools-mcp@latest']);
  assert.equal(spec.options.stdio, 'inherit');
});

test('Test 2: buildMcpSpawnSpec forwards caller args after package name', () => {
  const spec = buildMcpSpawnSpec(['--headless=false', '--allowUnrestrictedPaths']);

  assert.deepEqual(spec.args, [
    '-y',
    'chrome-devtools-mcp@latest',
    '--headless=false',
    '--allowUnrestrictedPaths',
  ]);
});

test('Test 3: runPassthrough preserves child exit code without polluting stdout', async () => {
  const code = await runPassthrough(
    ['-e', 'process.exit(0)'],
    (args) => ({ command: process.execPath, args, options: { stdio: 'inherit' } })
  );

  assert.equal(code, 0);
});

test('Test 4: buildChromeSpawnSpec configures detached Chrome on 9222 with userDataDir', () => {
  const spec = buildChromeSpawnSpec({
    port: 9222,
    userDataDir: 'C:\\Users\\mohds\\.chrome-dev-profile-launcher-test',
  });

  assert.equal(spec.command, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.deepEqual(spec.args, [
    '--remote-debugging-port=9222',
    '--user-data-dir=C:\\Users\\mohds\\.chrome-dev-profile-launcher-test',
  ]);
  assert.deepEqual(spec.options, { detached: true, stdio: 'ignore' });
});

test('Test 5: buildMcpSpawnSpec includes --browserUrl when provided', () => {
  const spec = buildMcpSpawnSpec(['--allowUnrestrictedPaths'], {
    browserUrl: 'http://127.0.0.1:9222',
  });

  assert.deepEqual(spec.args, [
    '-y',
    'chrome-devtools-mcp@latest',
    '--browserUrl=http://127.0.0.1:9222',
    '--allowUnrestrictedPaths',
  ]);
});

test('Test 6: launchAndRun spawns detached Chrome, unrefs, waits, and runs MCP with browserUrl', async () => {
  const events = [];
  const fakeSpawn = (cmd, args, opts) => {
    events.push({ cmd, args, opts });
    return { unref: () => events.push('unref') };
  };
  const fakeWait = async (ms) => events.push(`wait:${ms}`);
  const fakeRunMcp = async (extraArgs, opts) => {
    events.push({ extraArgs, opts });
    return 0;
  };

  let probeCalls = 0;
  const code = await launchAndRun(['--allowUnrestrictedPaths'], {
    port: 9222,
    userDataDir: 'C:\\temp\\profile',
    spawnChrome: fakeSpawn,
    probeFn: async () => ++probeCalls >= 2,
    waitFn: fakeWait,
    runMcp: fakeRunMcp,
  });

  assert.equal(code, 0);
  assert.equal(events[1], 'unref');
  assert.deepEqual(events[2], {
    extraArgs: ['--allowUnrestrictedPaths'],
    opts: { browserUrl: 'http://127.0.0.1:9222' },
  });
});

test('Test 7: waitForPort resolves once probeFn returns true', async () => {
  let calls = 0;
  const probeFn = async () => ++calls >= 3;
  const waits = [];
  const waitFn = async (ms) => waits.push(ms);

  await waitForPort({ port: 9223, probeFn, waitFn, timeoutMs: 1000, intervalMs: 200 });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [200, 200]);
});

test('Test 8: waitForPort rejects with port and timeout when probeFn never succeeds', async () => {
  const probeFn = async () => false;
  const waitFn = async () => {};

  await assert.rejects(
    () => waitForPort({ port: 9223, probeFn, waitFn, timeoutMs: 400, intervalMs: 200 }),
    /400ms.*9223/
  );
});

test('Test 9: launchAndRun polls readiness instead of fixed 5000ms wait', async () => {
  const waits = [];
  const code = await launchAndRun(['--allowUnrestrictedPaths'], {
    port: 9223,
    userDataDir: 'C:\\temp\\profile',
    spawnChrome: () => ({ unref: () => {} }),
    probeFn: async () => true,
    waitFn: async (ms) => waits.push(ms),
    runMcp: async () => 0,
  });

  assert.equal(code, 0);
  assert.deepEqual(waits, []);
});

test('Test 10: launchAndRun skips spawning Chrome when port is already ready', async () => {
  let spawned = 0;
  let mcpOpts = null;
  const code = await launchAndRun(['--allowUnrestrictedPaths'], {
    port: 9223,
    userDataDir: 'C:\\temp\\profile',
    spawnChrome: () => {
      spawned++;
      return { unref: () => {} };
    },
    probeFn: async () => true,
    waitFn: async () => {},
    runMcp: async (_args, opts) => {
      mcpOpts = opts;
      return 0;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned, 0);
  assert.deepEqual(mcpOpts, { browserUrl: 'http://127.0.0.1:9223' });
});

test('Test 11: launchAndRun spawns Chrome once when port is not initially ready', async () => {
  let spawned = 0;
  let probeCalls = 0;
  const code = await launchAndRun([], {
    port: 9223,
    userDataDir: 'C:\\temp\\profile',
    spawnChrome: () => {
      spawned++;
      return { unref: () => {} };
    },
    probeFn: async () => ++probeCalls >= 2,
    waitFn: async () => {},
    runMcp: async () => 0,
  });

  assert.equal(code, 0);
  assert.equal(spawned, 1);
});

test('Test 12: partitionArgs extracts --userDataDir and forwards all other flags', () => {
  const result = partitionArgs([
    '--userDataDir=C:\\p',
    '--logFile',
    'C:\\a.log',
    '--allowUnrestrictedPaths',
    '--categoryExtensions',
  ]);

  assert.equal(result.userDataDir, 'C:\\p');
  assert.deepEqual(result.mcpArgs, [
    '--logFile',
    'C:\\a.log',
    '--allowUnrestrictedPaths',
    '--categoryExtensions',
  ]);
});

test('Test 13: partitionArgs handles space-separated --userDataDir', () => {
  const result = partitionArgs(['--userDataDir', 'C:\\p', '--allowUnrestrictedPaths']);

  assert.equal(result.userDataDir, 'C:\\p');
  assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
});

test('Test 14: runPassthrough forwards non-zero child exit code', async () => {
  const code = await runPassthrough(
    ['-e', 'process.exit(7)'],
    (args) => ({ command: process.execPath, args, options: { stdio: 'inherit' } })
  );

  assert.equal(code, 7);
});

test('Test 15: wireLifecycle forwards SIGTERM to child and cleans up listeners', () => {
  const proc = new EventEmitter();
  const killed = [];
  const child = { kill: (sig) => killed.push(sig) };

  const detach = wireLifecycle(child, proc);
  proc.emit('SIGTERM');
  detach();
  proc.emit('SIGINT');

  assert.deepEqual(killed, ['SIGTERM']);
});

test('Test 16: diagnoseStartupFailure reports port conflict when port is occupied', async () => {
  const msg = await diagnoseStartupFailure({
    port: 9223,
    userDataDir: 'C:\\temp\\profile',
    portOccupiedFn: async () => true,
    lockExistsFn: () => false,
  });

  assert.match(msg, /Port 9223 is already in use/i);
});

test('Test 17: diagnoseStartupFailure reports profile lock when lockfile exists without debug port', async () => {
  const msg = await diagnoseStartupFailure({
    port: 9223,
    userDataDir: 'C:\\temp\\profile',
    portOccupiedFn: async () => false,
    lockExistsFn: () => true,
  });

  assert.match(msg, /locked.*--remote-debugging-port=9223/i);
});

test('Test 18: launchAndRun does not spawn Chrome on startup when lazy=true until tools/call', async () => {
  let spawned = 0;
  const fakeEnsure = async () => {
    spawned++;
  };
  const { isToolCallMessage } = await import('./mcp-chrome-launcher.mjs');

  assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'), false);
  assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'), false);
  assert.equal(isToolCallMessage('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{}}\n'), true);
  assert.equal(spawned, 0);
  await fakeEnsure();
  assert.equal(spawned, 1);
});
