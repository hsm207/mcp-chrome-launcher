import { describe, expect, test } from 'vitest';
import { findChromePath } from '../../mcp-chrome-launcher.mjs';

describe('chrome-discovery', () => {
  test('Given no Chrome binary on disk, when findChromePath runs, then it throws an agent-friendly error', () => {
    expect(() => findChromePath({ platform: 'linux', env: {}, existsSync: () => false })).toThrow(
      /Chrome executable not found.*--chromePath=<path>/s
    );
  });
});
