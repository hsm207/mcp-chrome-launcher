import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEFAULT_PORT = 9223;
const DEFAULT_USER_DATA_DIR = 'C:\\Users\\mohds\\.chrome-dev-profile';

/**
 * Checks whether Chrome's DevTools HTTP endpoint responds with 200 OK.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isPortReady(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Polls `probeFn` every `intervalMs` until it returns true or `timeoutMs` elapses.
 */
export async function waitForPort({
  port = DEFAULT_PORT,
  probeFn = () => isPortReady(port),
  waitFn = delay,
  timeoutMs = 15000,
  intervalMs = 200,
} = {}) {
  const maxAttempts = Math.max(1, Math.floor(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await probeFn()) {
      return;
    }
    if (attempt + 1 < maxAttempts) {
      await waitFn(intervalMs);
    }
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for Chrome DevTools on port ${port}`);
}

/**
 * Checks whether any TCP listener is accepting connections on `127.0.0.1:port`.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isPortOccupied(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Checks whether Chrome's profile lockfile exists in `userDataDir`.
 * @param {string} userDataDir
 * @returns {boolean}
 */
export function hasProfileLock(userDataDir) {
  return existsSync(path.join(userDataDir, 'lockfile')) || existsSync(path.join(userDataDir, 'SingletonLock'));
}

/**
 * Diagnoses why Chrome failed to expose DevTools on `port`.
 */
export async function diagnoseStartupFailure({
  port = DEFAULT_PORT,
  userDataDir = DEFAULT_USER_DATA_DIR,
  portOccupiedFn = isPortOccupied,
  lockExistsFn = hasProfileLock,
} = {}) {
  if (await portOccupiedFn(port)) {
    return `Port ${port} is already in use by another process (not Chrome DevTools).`;
  }
  if (lockExistsFn(userDataDir)) {
    return `Profile "${userDataDir}" is locked by an existing Chrome without --remote-debugging-port=${port}. Close it and retry.`;
  }
  return `Chrome failed to expose DevTools on port ${port} for profile "${userDataDir}".`;
}

/**
 * Partitions CLI args into launcher-owned flags and MCP-forwarded flags.
 * @param {string[]} [args]
 */
export function partitionArgs(args = []) {
  let userDataDir = DEFAULT_USER_DATA_DIR;
  let headless = false;
  const mcpArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--userDataDir=')) {
      userDataDir = arg.slice('--userDataDir='.length);
    } else if (arg === '--userDataDir' && i + 1 < args.length) {
      userDataDir = args[++i];
    } else {
      mcpArgs.push(arg);
    }
  }

  return { userDataDir, headless, mcpArgs };
}

/**
 * Builds the detached Chrome spawn specification.
 * @param {{ port?: number, userDataDir?: string, chromePath?: string }} [opts]
 */
export function buildChromeSpawnSpec({
  port = DEFAULT_PORT,
  userDataDir = DEFAULT_USER_DATA_DIR,
  chromePath = DEFAULT_CHROME_PATH,
} = {}) {
  return {
    command: chromePath,
    args: [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    options: { detached: true, stdio: 'ignore' },
  };
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
 * Spawns detached Chrome on the debug port, waits, then runs chrome-devtools-mcp attached to it.
 * @param {string[]} [extraArgs]
 * @param {object} [deps]
 */
export async function launchAndRun(
  extraArgs = [],
  {
    port = DEFAULT_PORT,
    userDataDir = DEFAULT_USER_DATA_DIR,
    spawnChrome = spawn,
    probeFn = () => isPortReady(port),
    waitFn = delay,
    timeoutMs = 15000,
    intervalMs = 200,
    runMcp = null,
  } = {}
) {
  const parsed = partitionArgs(extraArgs);
  const resolvedUserDataDir = userDataDir ?? parsed.userDataDir;

  const ensureChrome = async () => {
    if (!(await probeFn())) {
      const chromeSpec = buildChromeSpawnSpec({ port, userDataDir: resolvedUserDataDir });
      const chrome = spawnChrome(chromeSpec.command, chromeSpec.args, chromeSpec.options);
      chrome.unref();

      try {
        await waitForPort({ port, probeFn, waitFn, timeoutMs, intervalMs });
      } catch (err) {
        const diagnosis = await diagnoseStartupFailure({ port, userDataDir: resolvedUserDataDir });
        throw new Error(`${err.message}. ${diagnosis}`);
      }
    }
  };

  if (runMcp) {
    await ensureChrome();
    return runMcp(parsed.mcpArgs, { browserUrl: `http://127.0.0.1:${port}` });
  }

  const { command, args, options } = buildMcpSpawnSpec(parsed.mcpArgs, {
    browserUrl: `http://127.0.0.1:${port}`,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launchAndRun(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[mcp-chrome-launcher] ${err.message}`);
      process.exit(1);
    });
}
