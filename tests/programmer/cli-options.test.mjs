import { describe, expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { partitionArgs } from '../../mcp-chrome-launcher.mjs';

describe('cli-options', () => {
  test('Given no args, when partitionArgs runs, then userDataDir defaults to ~/.chrome-dev-profile', () => {
    expect(partitionArgs([]).userDataDir).toBe(path.join(os.homedir(), '.chrome-dev-profile'));
  });

  test('Given --userDataDir=, when partitionArgs runs, then it extracts userDataDir and forwards remaining flags', () => {
    const result = partitionArgs(['--userDataDir=C:\\p', '--allowUnrestrictedPaths', '--logFile', 'C:\\a.log']);
    expect(result.userDataDir).toBe('C:\\p');
    expect(result.mcpArgs).toEqual(['--allowUnrestrictedPaths', '--logFile', 'C:\\a.log']);
  });

  test('Given space-separated --userDataDir, when partitionArgs runs, then it extracts userDataDir', () => {
    const result = partitionArgs(['--userDataDir', 'C:\\p', '--allowUnrestrictedPaths']);
    expect(result.userDataDir).toBe('C:\\p');
    expect(result.mcpArgs).toEqual(['--allowUnrestrictedPaths']);
  });

  test('Given no args, when partitionArgs runs, then port defaults to 9223', () => {
    expect(partitionArgs([]).port).toBe(9223);
  });

  test('Given --port=9225, when partitionArgs runs, then it extracts port 9225 and forwards remaining flags', () => {
    const result = partitionArgs(['--port=9225', '--allowUnrestrictedPaths']);
    expect(result.port).toBe(9225);
    expect(result.mcpArgs).toEqual(['--allowUnrestrictedPaths']);
  });

  test('Given space-separated --port, when partitionArgs runs, then it extracts port', () => {
    expect(partitionArgs(['--port', '9226']).port).toBe(9226);
  });

  test('Given invalid --port, when partitionArgs runs, then it throws an error', () => {
    expect(() => partitionArgs(['--port=abc'])).toThrow(/Invalid --port/i);
  });

  test('Given no args, when partitionArgs runs, then chromePath defaults to null', () => {
    expect(partitionArgs([]).chromePath).toBeNull();
  });

  test('Given --chromePath=, when partitionArgs runs, then it extracts chromePath and forwards remaining flags', () => {
    const result = partitionArgs(['--chromePath=/custom/chrome', '--allowUnrestrictedPaths']);
    expect(result.chromePath).toBe('/custom/chrome');
    expect(result.mcpArgs).toEqual(['--allowUnrestrictedPaths']);
  });

  test('Given space-separated --chromePath, when partitionArgs runs, then it extracts chromePath', () => {
    expect(partitionArgs(['--chromePath', '/custom/chrome']).chromePath).toBe('/custom/chrome');
  });

  test('Given --help or -h, when partitionArgs runs, then help is true', () => {
    expect(partitionArgs(['--help']).help).toBe(true);
    expect(partitionArgs(['-h']).help).toBe(true);
  });

  test('Given --version or -v, when partitionArgs runs, then version is true', () => {
    expect(partitionArgs(['--version']).version).toBe(true);
    expect(partitionArgs(['-v']).version).toBe(true);
  });
});
