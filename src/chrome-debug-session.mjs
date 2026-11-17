import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_PORT, DEFAULT_USER_DATA_DIR } from './cli-options.mjs';
import { findChromePath } from './chrome-discovery.mjs';

/**
 * Builds the detached Chrome spawn specification.
 * @param {{ port?: number, userDataDir?: string, chromePath?: string | null }} [opts]
 */
export function buildChromeSpawnSpec({
  port = DEFAULT_PORT,
  userDataDir = DEFAULT_USER_DATA_DIR,
  chromePath = null,
} = {}) {
  return {
    command: chromePath ?? findChromePath(),
    args: [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    options: { detached: true, stdio: 'ignore' },
  };
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
