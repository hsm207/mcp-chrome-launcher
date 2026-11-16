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
 * Spawns detached Chrome on the debug port, waits, then runs chrome-devtools-mcp attached to it.
 * @param {string[]} [extraArgs]
 * @param {object} [deps]
 */
export async function launchAndRun(extraArgs = [], deps = {}) {
  const { port, mcpArgs, ensureChrome } = resolveLaunchConfig(extraArgs, deps);

  if (deps.runMcp) {
    await ensureChrome();
    return deps.runMcp(mcpArgs, { browserUrl: `http://127.0.0.1:${port}` });
  }

  const { command, args, options } = buildMcpSpawnSpec(mcpArgs, {
    browserUrl: `http://127.0.0.1:${port}`,
  });
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'inherit', 'inherit'] });
  const detach = wireLifecycle(child);
  bridgeStdio(child, ensureChrome);
  return awaitChildExit(child, detach);
}

/**
 * Spawns a child process with inherited stdio and resolves with its exit code.
 * @param {string[]} [extraArgs]
 * @param {(extraArgs: string[]) => object} [specBuilder]
 * @returns {Promise<number>}
 */
export function runPassthrough(extraArgs = [], specBuilder = buildMcpSpawnSpec) {
  const { command, args, options } = specBuilder(extraArgs);
  const child = spawn(command, args, options);
  const detach = wireLifecycle(child);
  return awaitChildExit(child, detach);
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

function bridgeStdio(child, ensureChrome) {
  const runEnsure = createSerializedEnsure(ensureChrome);

  process.stdin.on('data', (chunk) => forwardStdinChunk(chunk, child, runEnsure));
  process.stdin.on('end', () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });
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

async function forwardStdinChunk(chunk, child, runEnsure) {
  if (isToolCallMessage(chunk.toString('utf8'))) {
    process.stdin.pause();
    try {
      await runEnsure();
    } catch (err) {
      console.error(`[mcp-chrome-launcher] ${err.message}`);
    } finally {
      process.stdin.resume();
    }
  }
  if (!child.stdin.destroyed) {
    child.stdin.write(chunk);
  }
}

function awaitChildExit(child, detach) {
  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      detach();
      reject(err);
    });
    child.on('exit', (code, signal) => {
      detach();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
