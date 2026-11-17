import { describe, expect } from 'vitest';
import { execa } from 'execa';
import { isPortReady } from '../../mcp-chrome-launcher.mjs';
import { CLI_PATH, test } from './launcher-fixtures.mjs';

describe('application: mcp-chrome-launcher CLI', () => {
  test('Given --version, when mcp-chrome-launcher runs, then it prints package version', async () => {
    const { exitCode, stdout } = await execa(process.execPath, [CLI_PATH, '--version'], { reject: false });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('Given --help, when mcp-chrome-launcher runs, then it prints usage options', async () => {
    const { exitCode, stdout } = await execa(process.execPath, [CLI_PATH, '--help'], { reject: false });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Usage: mcp-chrome-launcher/);
  });

  test('Given invalid --port, when mcp-chrome-launcher runs, then it exits 1 with an error message', async () => {
    const { exitCode, stderr } = await execa(process.execPath, [CLI_PATH, '--port=abc'], { reject: false });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/\[mcp-chrome-launcher\] Invalid --port/i);
  });

  test('Given mcp-chrome-launcher over stdio, when tools/call arrives, then it lazy-launches real Chrome on the configured port', async ({ launcher }) => {
    const port = 19226;
    const { sendRpc } = launcher(port);

    sendRpc('initialize');
    expect(await isPortReady(port)).toBe(false);

    sendRpc('tools/call', { name: 'list_pages' });
    await expect.poll(() => isPortReady(port), { timeout: 20000, interval: 250 }).toBe(true);
  }, 25000);

  test('Given an occupied port, when tools/call arrives, then mcp-chrome-launcher logs port conflict to stderr', async ({ launcher, occupiedPort }) => {
    const { sendRpc, getStderr } = launcher(occupiedPort);
    sendRpc('tools/call', { name: 'list_pages' });
    await expect.poll(getStderr, { timeout: 20000, interval: 250 }).toMatch(
      new RegExp(`Port ${occupiedPort} is already in use`, 'i')
    );
  }, 25000);
});
