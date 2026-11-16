import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_USER_DATA_DIR, partitionArgs } from './cli-options.mjs';
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
export async function launchAndRun(
  extraArgs = [],
  {
    port = null,
    userDataDir = DEFAULT_USER_DATA_DIR,
    chromePath = null,
    spawnChrome = spawn,
    probeFn = null,
    waitFn = delay,
    timeoutMs = 15000,
    intervalMs = 200,
    runMcp = null,
  } = {}
) {
  const parsed = partitionArgs(extraArgs);
  const resolvedPort = port ?? parsed.port;
  const resolvedUserDataDir = userDataDir ?? parsed.userDataDir;
  const resolvedChromePath = chromePath ?? parsed.chromePath ?? undefined;
  const resolvedProbeFn = probeFn ?? (() => isPortReady(resolvedPort));

  const ensureChrome = async () => {
    if (!(await resolvedProbeFn())) {
      const chromeSpec = buildChromeSpawnSpec({
        port: resolvedPort,
        userDataDir: resolvedUserDataDir,
        chromePath: resolvedChromePath,
      });
      const chrome = spawnChrome(chromeSpec.command, chromeSpec.args, chromeSpec.options);
      chrome.unref();

      try {
        await waitForPort({ port: resolvedPort, probeFn: resolvedProbeFn, waitFn, timeoutMs, intervalMs });
      } catch (err) {
        const diagnosis = await diagnoseStartupFailure({ port: resolvedPort, userDataDir: resolvedUserDataDir });
        throw new Error(`${err.message}. ${diagnosis}`);
      }
    }
  };

  if (runMcp) {
    await ensureChrome();
    return runMcp(parsed.mcpArgs, { browserUrl: `http://127.0.0.1:${resolvedPort}` });
  }

  const { command, args, options } = buildMcpSpawnSpec(parsed.mcpArgs, {
    browserUrl: `http://127.0.0.1:${resolvedPort}`,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'inherit', 'inherit'] });
    const detach = wireLifecycle(child);
    let inFlightEnsure = null;

    process.stdin.on('data', async (chunk) => {
      const text = chunk.toString('utf8');
      if (isToolCallMessage(text)) {
        process.stdin.pause();
        try {
          inFlightEnsure ??= ensureChrome().finally(() => {
            inFlightEnsure = null;
          });
          await inFlightEnsure;
        } catch (err) {
          console.error(`[mcp-chrome-launcher] ${err.message}`);
        } finally {
          process.stdin.resume();
        }
      }
      if (!child.stdin.destroyed) {
        child.stdin.write(chunk);
      }
    });

    process.stdin.on('end', () => {
      if (!child.stdin.destroyed) child.stdin.end();
    });

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

/**
 * Spawns a child process with inherited stdio and resolves with its exit code.
 * @param {string[]} [extraArgs]
 * @param {(extraArgs: string[]) => object} [specBuilder]
 * @returns {Promise<number>}
 */
export function runPassthrough(extraArgs = [], specBuilder = buildMcpSpawnSpec) {
  const { command, args, options } = specBuilder(extraArgs);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const detach = wireLifecycle(child);
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
