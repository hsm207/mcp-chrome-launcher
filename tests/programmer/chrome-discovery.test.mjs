import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { findChromePath } from '../../mcp-chrome-launcher.mjs';

describe('chrome-discovery', () => {
  test('Given no Chrome binary on disk, when findChromePath runs, then it throws an agent-friendly error', () => {
    assert.throws(
      () => findChromePath({ platform: 'linux', env: {}, existsSync: () => false }),
      /Chrome executable not found.*--chromePath=<path>/s
    );
  });
});
