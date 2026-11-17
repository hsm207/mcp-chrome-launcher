import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { partitionArgs } from './cli-options.mjs';
import {
  buildChromeSpawnSpec,
  diagnoseStartupFailure,
  isPortReady,
  waitForPort,
} from './chrome-debug-session.mjs';

/**
 * Spawns `chrome-devtools-mcp` and lazily launches detached Chrome on the first `tools/call`.
 * @param {string[]} [extraArgs]
 * @param {object} [deps]
 */
export async function launchAndRun(extraArgs = [], deps = {}) {
  const { port, mcpArgs, ensureChrome } = resolveLaunchConfig(extraArgs, deps);
  const spawnMcp = deps.spawnMcp ?? spawn;
  const { command, args, options } = buildMcpSpawnSpec(mcpArgs, {
    browserUrl: `http://127.0.0.1:${port}`,
  });

  const child = spawnMcp(command, args, { ...options, stdio: ['pipe', 'inherit', 'inherit'] });
  const detachSignals = wireLifecycle(child);
  const detachStdin = bridgeStdio(child, ensureChrome, {
    stdin: deps.stdin,
    logError: deps.logError,
  });

  return awaitChildExit(child, () => {
    detachStdin();
    detachSignals();
  });
}

/**
 * Spawns a child process with inherited stdio and resolves with its exit code.
 * @param {string[]} [extraArgs]
 * @param {(extraArgs: string[]) => object} [specBuilder]
 * @param {typeof spawn} [spawnMcp]
 * @returns {Promise<number>}
 */
export function runPassthrough(extraArgs = [], specBuilder = buildMcpSpawnSpec, spawnMcp = spawn) {
  const { command, args, options } = specBuilder(extraArgs);
  const child = spawnMcp(command, args, options);
  const detach = wireLifecycle(child);
  return awaitChildExit(child, detach);
}

/**
 * Bridges `stdin` to `child.stdin`, lazily invoking `ensureChrome` on `tools/call`.
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => Promise<void>} ensureChrome
 * @param {{ stdin?: NodeJS.ReadableStream, logError?: (msg: string) => void }} [io]
 * @returns {() => void}
 */
export function bridgeStdio(
  child,
  ensureChrome,
  { stdin = process.stdin, logError = console.error } = {}
) {
  const runEnsure = createSerializedEnsure(ensureChrome);
  const onData = (chunk) => forwardStdinChunk(chunk, child, runEnsure, { stdin, logError });
  const onEnd = () => {
    if (!child.stdin.destroyed) child.stdin.end();
  };

  stdin.on('data', onData);
  stdin.on('end', onEnd);
  return () => {
    stdin.off('data', onData);
    stdin.off('end', onEnd);
  };
}

/**
 * Awaits child process exit or error, invoking `cleanup` before settling.
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => void} cleanup
 * @returns {Promise<number>}
 */
export function awaitChildExit(child, cleanup) {
  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('exit', (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}

/**
 * Builds the spawn specification for chrome-devtools-mcp.
 * @param {string[]} [extraArgs]
 * @param {{ browserUrl?: string }} [opts]
 */
export function buildMcpSpawnSpec(extraArgs = [], { browserUrl } = {}) {
  const browserArgs = browserUrl ? [`--browserUrl=${browserUrl}`] : [];
  return {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest', ...browserArgs, ...extraArgs],
    options: {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  };
}

/**
 * Forwards SIGINT/SIGTERM to the MCP child process and returns a cleanup function.
 */
export function wireLifecycle(child, proc = process) {
  const onSigInt = () => child.kill('SIGINT');
  const onSigTerm = () => child.kill('SIGTERM');
  proc.on('SIGINT', onSigInt);
  proc.on('SIGTERM', onSigTerm);
  return () => {
    proc.off('SIGINT', onSigInt);
    proc.off('SIGTERM', onSigTerm);
  };
}

/**
 * Returns true if a JSON-RPC stdin chunk contains a `tools/call` request.
 * @param {string} chunk
 * @returns {boolean}
 */
export function isToolCallMessage(chunk) {
  return chunk.includes('"tools/call"');
}

function resolveLaunchConfig(extraArgs, deps) {
  const parsed = partitionArgs(extraArgs);
  const port = deps.port ?? parsed.port;
  const userDataDir = deps.userDataDir ?? parsed.userDataDir;
  const chromePath = deps.chromePath ?? parsed.chromePath ?? undefined;
  const probeFn = deps.probeFn ?? (() => isPortReady(port));

  const ensureChrome = createEnsureChrome({
    port,
    userDataDir,
    chromePath,
    spawnChrome: deps.spawnChrome ?? spawn,
    probeFn,
    waitFn: deps.waitFn ?? delay,
    timeoutMs: deps.timeoutMs ?? 15000,
    intervalMs: deps.intervalMs ?? 200,
  });

  return { port, mcpArgs: parsed.mcpArgs, ensureChrome };
}

function createEnsureChrome({
  port,
  userDataDir,
  chromePath,
  spawnChrome,
  probeFn,
  waitFn,
  timeoutMs,
  intervalMs,
}) {
  return async () => {
    if (await probeFn()) return;

    const chromeSpec = buildChromeSpawnSpec({ port, userDataDir, chromePath });
    const chrome = spawnChrome(chromeSpec.command, chromeSpec.args, chromeSpec.options);
    chrome.unref();

    try {
      await waitForPort({ port, probeFn, waitFn, timeoutMs, intervalMs });
    } catch (err) {
      const diagnosis = await diagnoseStartupFailure({ port, userDataDir });
      throw new Error(`${err.message}. ${diagnosis}`);
    }
  };
}

function createSerializedEnsure(ensureChrome) {
  let inFlight = null;
  return () => {
    inFlight ??= ensureChrome().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

async function forwardStdinChunk(chunk, child, runEnsure, { stdin, logError }) {
  if (isToolCallMessage(chunk.toString('utf8'))) {
    stdin.pause();
    try {
      await runEnsure();
    } catch (err) {
      logError(`[mcp-chrome-launcher] ${err.message}`);
    } finally {
      stdin.resume();
    }
  }
  if (!child.stdin.destroyed) {
    child.stdin.write(chunk);
  }
}
