import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Discovers the Chrome executable path for the current platform.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, existsSync?: (p: string) => boolean }} [opts]
 * @returns {string}
 */
export function findChromePath({
  platform = process.platform,
  env = process.env,
  existsSync: existsFn = existsSync,
} = {}) {
  const candidates = getChromeCandidates(platform, env);
  const found = candidates.find((candidate) => existsFn(candidate));
  if (found) {
    return found;
  }
  throw new Error(
    `Chrome executable not found for platform "${platform}". Searched:\n` +
      candidates.map((c) => `  - ${c}`).join('\n') +
      '\nPass --chromePath=<path> in your MCP server args.'
  );
}

function getChromeCandidates(platform, env) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return roots.map((root) => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') {
    const home = env.HOME || os.homedir();
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.posix.join(home, 'Applications', 'Google Chrome.app', 'Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}
