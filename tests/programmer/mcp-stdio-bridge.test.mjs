import { describe, expect, onTestFinished, test } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import {
  buildMcpSpawnSpec,
  isToolCallMessage,
  launchAndRun,
  runPassthrough,
  wireLifecycle,
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

  test('Given a real DevTools server on port, when launchAndRun runs, then it passes browserUrl to runMcp', async () => {
    const srv = await startRealDevToolsServer();
    onTestFinished(() => srv.close());
    const code = await launchAndRun(['--allowUnrestrictedPaths'], {
      port: srv.port,
      runMcp: async (args, opts) => {
        expect(args).toEqual(['--allowUnrestrictedPaths']);
        expect(opts).toEqual({ browserUrl: `http://127.0.0.1:${srv.port}` });
        return 0;
      },
    });
    expect(code).toBe(0);
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
