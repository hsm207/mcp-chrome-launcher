import { describe, expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { findChromePath } from '../../mcp-chrome-launcher.mjs';

describe('chrome-discovery', () => {
  test('Given win32, when findChromePath runs, then it discovers Chrome in Program Files', () => {
    const expected = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const found = findChromePath({
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files' },
      existsSync: (p) => p === expected,
    });
    expect(found).toBe(expected);
  });

  test('Given darwin with HOME, when findChromePath runs, then it discovers user Applications Chrome', () => {
    const expected = '/Users/test/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const found = findChromePath({
      platform: 'darwin',
      env: { HOME: '/Users/test' },
      existsSync: (p) => p === expected,
    });
    expect(found).toBe(expected);
  });

  test('Given darwin without HOME, when findChromePath runs, then it falls back to os.homedir()', () => {
    const expected = path.posix.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents/MacOS/Google Chrome');
    const found = findChromePath({
      platform: 'darwin',
      env: {},
      existsSync: (p) => p === expected,
    });
    expect(found).toBe(expected);
  });

  test('Given linux, when findChromePath runs, then it discovers /usr/bin/google-chrome', () => {
    const found = findChromePath({
      platform: 'linux',
      env: {},
      existsSync: (p) => p === '/usr/bin/google-chrome',
    });
    expect(found).toBe('/usr/bin/google-chrome');
  });

  test('Given no Chrome binary on disk, when findChromePath runs, then it throws an agent-friendly error', () => {
    expect(() => findChromePath({ platform: 'linux', env: {}, existsSync: () => false })).toThrow(
      /Chrome executable not found.*--chromePath=<path>/s
    );
  });
});
