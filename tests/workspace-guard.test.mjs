import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

test('Linux workspace guard: real Git, leases and process consumers', {
  skip: process.platform !== 'linux' ? 'linux-local-flock-v1 is not admitted on this platform' : false,
}, (context) => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover',
    '-s', 'tests', '-p', 'test_workspace_guard.py', '-v'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  context.diagnostic(result.stdout + result.stderr);
});
