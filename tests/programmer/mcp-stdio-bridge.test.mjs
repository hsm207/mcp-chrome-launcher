import { describe, expect, onTestFinished, test } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import {
  awaitChildExit,
  bridgeStdio,
  buildMcpSpawnSpec,
  isToolCallMessage,
  launchAndRun,
  runPassthrough,
  wireLifecycle,
} from '../../src/mcp-stdio-bridge.mjs';

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

function createFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.kill = () => {};
  return child;
}

describe('mcp-stdio-bridge', () => {
  test('Given no args, when buildMcpSpawnSpec runs, then it defaults to npx chrome-devtools-mcp@latest', () => {
    const spec = buildMcpSpawnSpec([]);
    expect(spec.command).toBe('npx');
    expect(spec.args).toEqual(['-y', 'chrome-devtools-mcp@latest']);
    expect(spec.options.stdio).toBe('inherit');
    expect(spec.options.shell).toBe(process.platform === 'win32');
  });

  test('Given caller args, when buildMcpSpawnSpec runs, then it forwards them after package name', () => {
    const spec = buildMcpSpawnSpec(['--allowUnrestrictedPaths', '--categoryExtensions']);
    expect(spec.args).toEqual(['-y', 'chrome-devtools-mcp@latest', '--allowUnrestrictedPaths', '--categoryExtensions']);
  });

  test('Given browserUrl, when buildMcpSpawnSpec runs, then it includes --browserUrl', () => {
    const spec = buildMcpSpawnSpec(['--allowUnrestrictedPaths'], { browserUrl: 'http://127.0.0.1:9222' });
    expect(spec.args).toEqual(['-y', 'chrome-devtools-mcp@latest', '--browserUrl=http://127.0.0.1:9222', '--allowUnrestrictedPaths']);
  });

  test('Given child exits 0, when runPassthrough runs, then it resolves with 0', async () => {
    const code = await runPassthrough([], () => ({ command: process.execPath, args: ['-e', 'process.exit(0)'], options: { stdio: 'inherit' } }));
    expect(code).toBe(0);
  });

  test('Given child exits 42, when runPassthrough runs, then it forwards exit code 42', async () => {
    const code = await runPassthrough([], () => ({ command: process.execPath, args: ['-e', 'process.exit(42)'], options: { stdio: 'inherit' } }));
    expect(code).toBe(42);
  });

  test('Given non-existent command, when runPassthrough runs, then it rejects with spawn error', async () => {
    await expect(
      runPassthrough([], () => ({ command: 'nonexistent-cmd-xyz-12345', args: [], options: { stdio: 'ignore' } }))
    ).rejects.toThrow(/ENOENT/);
  });

  test('Given a real DevTools server on port, when launchAndRun runs, then it spawns MCP with --browserUrl and cleans up', async () => {
    const srv = await startRealDevToolsServer();
    onTestFinished(() => srv.close());
    const stdin = new PassThrough();
    const child = createFakeChild();
    let capturedArgs = null;

    const runPromise = launchAndRun(['--allowUnrestrictedPaths'], {
      port: srv.port,
      stdin,
      spawnMcp: (_cmd, args) => {
        capturedArgs = args;
        return child;
      },
    });
    child.emit('exit', 0);
    expect(await runPromise).toBe(0);
    expect(capturedArgs).toContain(`--browserUrl=http://127.0.0.1:${srv.port}`);
  });

  test('Given child.stdin is destroyed, when stdin emits data and end, then bridgeStdio skips write and end cleanly', async () => {
    const stdin = new PassThrough();
    const child = createFakeChild();
    child.stdin.destroy();
    const detach = bridgeStdio(child, async () => {}, { stdin, logError: () => {} });

    stdin.emit('data', Buffer.from('{"method":"initialize"}\n'));
    stdin.emit('data', Buffer.from('{"method":"tools/call"}\n'));
    stdin.emit('end');
    await new Promise((r) => setImmediate(r));
    detach();
    expect(child.stdin.destroyed).toBe(true);
  });

  test('Given ensureChrome throws, when bridgeStdio sees tools/call, then it logs the error', async () => {
    const stdin = new PassThrough();
    const child = createFakeChild();
    const errors = [];
    const detach = bridgeStdio(child, async () => { throw new Error('boom'); }, {
      stdin,
      logError: (msg) => errors.push(msg),
    });

    stdin.emit('data', Buffer.from('{"method":"tools/call"}\n'));
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0]).toMatch(/boom/);
    detach();
  });

  test('Given child exits by signal, when awaitChildExit runs, then it resolves to 1 after cleanup', async () => {
    const child = createFakeChild();
    let cleaned = false;
    const exitPromise = awaitChildExit(child, () => { cleaned = true; });
    child.emit('exit', null, 'SIGTERM');
    expect(await exitPromise).toBe(1);
    expect(cleaned).toBe(true);
  });

  test('Given child emits error, when awaitChildExit runs, then it rejects after cleanup', async () => {
    const child = createFakeChild();
    let cleaned = false;
    const exitPromise = awaitChildExit(child, () => { cleaned = true; });
    child.emit('error', new Error('spawn failed'));
    await expect(exitPromise).rejects.toThrow(/spawn failed/);
    expect(cleaned).toBe(true);
  });

  test('Given a real child process, when wireLifecycle detaches, then listener count returns to baseline', () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    const before = process.listenerCount('SIGTERM');
    const detach = wireLifecycle(child);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    detach();
    expect(process.listenerCount('SIGTERM')).toBe(before);
    child.kill();
  });

  test('Given tools/call JSON-RPC chunk, when isToolCallMessage runs, then it returns true', () => {
    expect(isToolCallMessage('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{}}\n')).toBe(true);
  });

  test('Given initialize or tools/list chunk, when isToolCallMessage runs, then it returns false', () => {
    expect(isToolCallMessage('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')).toBe(false);
    expect(isToolCallMessage('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n')).toBe(false);
  });
});
