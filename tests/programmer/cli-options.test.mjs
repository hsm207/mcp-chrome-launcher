import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { partitionArgs } from '../../mcp-chrome-launcher.mjs';

describe('cli-options', () => {
  test('Given no args, when partitionArgs runs, then userDataDir defaults to ~/.chrome-dev-profile', () => {
    assert.equal(partitionArgs([]).userDataDir, path.join(os.homedir(), '.chrome-dev-profile'));
  });

  test('Given --userDataDir=, when partitionArgs runs, then it extracts userDataDir and forwards remaining flags', () => {
    const result = partitionArgs(['--userDataDir=C:\\p', '--allowUnrestrictedPaths', '--logFile', 'C:\\a.log']);
    assert.equal(result.userDataDir, 'C:\\p');
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths', '--logFile', 'C:\\a.log']);
  });

  test('Given space-separated --userDataDir, when partitionArgs runs, then it extracts userDataDir', () => {
    const result = partitionArgs(['--userDataDir', 'C:\\p', '--allowUnrestrictedPaths']);
    assert.equal(result.userDataDir, 'C:\\p');
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
  });

  test('Given no args, when partitionArgs runs, then port defaults to 9223', () => {
    assert.equal(partitionArgs([]).port, 9223);
  });

  test('Given --port=9225, when partitionArgs runs, then it extracts port 9225 and forwards remaining flags', () => {
    const result = partitionArgs(['--port=9225', '--allowUnrestrictedPaths']);
    assert.equal(result.port, 9225);
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
  });

  test('Given space-separated --port, when partitionArgs runs, then it extracts port', () => {
    assert.equal(partitionArgs(['--port', '9226']).port, 9226);
  });

  test('Given invalid --port, when partitionArgs runs, then it throws an error', () => {
    assert.throws(() => partitionArgs(['--port=abc']), /Invalid --port/i);
  });

  test('Given no args, when partitionArgs runs, then chromePath defaults to null', () => {
    assert.equal(partitionArgs([]).chromePath, null);
  });

  test('Given --chromePath=, when partitionArgs runs, then it extracts chromePath and forwards remaining flags', () => {
    const result = partitionArgs(['--chromePath=/custom/chrome', '--allowUnrestrictedPaths']);
    assert.equal(result.chromePath, '/custom/chrome');
    assert.deepEqual(result.mcpArgs, ['--allowUnrestrictedPaths']);
  });

  test('Given space-separated --chromePath, when partitionArgs runs, then it extracts chromePath', () => {
    assert.equal(partitionArgs(['--chromePath', '/custom/chrome']).chromePath, '/custom/chrome');
  });

  test('Given --help or -h, when partitionArgs runs, then help is true', () => {
    assert.equal(partitionArgs(['--help']).help, true);
    assert.equal(partitionArgs(['-h']).help, true);
  });

  test('Given --version or -v, when partitionArgs runs, then version is true', () => {
    assert.equal(partitionArgs(['--version']).version, true);
    assert.equal(partitionArgs(['-v']).version, true);
  });
});
