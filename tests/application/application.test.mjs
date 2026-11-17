import { describe, expect } from 'vitest';
import { execa } from 'execa';
import { isPortReady } from '../../mcp-chrome-launcher.mjs';
import { CLI_PATH, test } from './launcher-fixtures.mjs';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

describe('application: mcp-chrome-launcher CLI', () => {
  test('Given --version, when mcp-chrome-launcher runs, then it prints package version', async () => {
    const { exitCode, stdout } = await execa(process.execPath, [CLI_PATH, '--version'], { reject: false });
    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('Given --help, when mcp-chrome-launcher runs, then it prints usage options', async () => {
    const { exitCode, stdout } = await execa(process.execPath, [CLI_PATH, '--help'], { reject: false });
    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(stdout).toMatch(/Usage: mcp-chrome-launcher/);
  });

  test('Given invalid --port, when mcp-chrome-launcher runs, then it exits 1 with an error message', async () => {
    const { exitCode, stderr } = await execa(process.execPath, [CLI_PATH, '--port=abc'], { reject: false });
    expect(exitCode).toBe(EXIT_FAILURE);
    expect(stderr).toMatch(/\[mcp-chrome-launcher\] Invalid --port/i);
  });

  test('Given mcp-chrome-launcher over stdio, when tools/call arrives, then it lazy-launches real Chrome on the configured port', async ({ launcher, freePort }) => {
    const port = freePort;
    const { sendRpc } = launcher(port);

    sendRpc('initialize');
    expect(await isPortReady(port)).toBe(false);

    sendRpc('tools/call', { name: 'list_pages' });
    await expect.poll(() => isPortReady(port), { timeout: 20000, interval: 250 }).toBe(true);
  }, 25000);

  test('Given an occupied port, when tools/call arrives, then mcp-chrome-launcher logs port conflict to stderr', async ({ launcher, occupiedPort }) => {
    // Node exits immediately on Chrome's flags, so this test never leaves behind a real
    // browser that could not expose DevTools on the already-occupied port.
    const { sendRpc, getStderr } = launcher(occupiedPort, [`--chromePath=${process.execPath}`]);
    sendRpc('tools/call', { name: 'list_pages' });
    await expect.poll(getStderr, { timeout: 20000, interval: 250 }).toMatch(
      new RegExp(`Port ${occupiedPort} is already in use`, 'i')
    );
  }, 25000);
});
