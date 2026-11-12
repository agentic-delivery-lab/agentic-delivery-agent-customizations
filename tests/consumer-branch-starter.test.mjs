import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { startIssueBranch } from '../scripts/start-issue-branch.mjs';

const execute = promisify(execFile);
const identity = Object.freeze({ name: 'example/selected', id: 1234 });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'consumer-branch-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execute('git', ['-C', root, ...args]);
  await git('init', '--quiet', '--initial-branch=main');
  await git('config', 'user.name', 'Consumer fixture');
  await git('config', 'user.email', 'consumer@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'consumer fixture\n');
  await git('add', 'README.md');
  await git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
  await git('remote', 'add', 'origin', 'https://github.com/example/selected.git');
  await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { root, git };
}

function githubBoundary(root, { state = 'open', issueUrl, pullRequest = false, id = 1234 } = {}) {
  return async (command, args, options) => {
    if (command !== 'gh') return execute(command, args, options);
    // The ambient repository deliberately has the opposite Issue state. Only
    // network access is faked; branch mutation uses real Git and real refs.
    const selected = options.cwd === root;
    const name = selected ? identity.name : 'example/ambient';
    const actualState = selected ? state : state === 'open' ? 'closed' : 'open';
    if (args[0] === 'repo') return { stdout: `${name}\n` };
    if (args[0] === 'issue') {
      return { stdout: `${actualState.toUpperCase()}\thttps://github.com/${name}/issues/2\n` };
    }
    assert.equal(args[0], 'api');
    assert.ok(args.includes('--hostname') && args.includes('github.com'));
    assert.ok(args.includes('--method') && args.includes('GET'));
    const endpoint = args.at(-1);
    if (endpoint === `repos/${identity.name}`) {
      return { stdout: JSON.stringify({ id, full_name: name }) };
    }
    assert.equal(endpoint, `repos/${identity.name}/issues/2`);
    return { stdout: JSON.stringify({ number: 2, state: actualState,
      html_url: issueUrl ?? `https://github.com/${name}/issues/2`,
      ...(pullRequest ? { pull_request: {} } : {}) }) };
  };
}

function request(root, options = {}) {
  return { branchType: 'feat', issueNumber: '2', summary: 'consumer-work',
    repositoryRoot: root, repositoryIdentity: identity,
    env: { PATH: process.env.PATH, HOME: os.homedir() },
    execFileImpl: githubBoundary(root, options) };
}

test('a selected consumer closed Issue cannot be replaced by an ambient open Issue', async (t) => {
  const { root, git } = await fixture(t);
  await assert.rejects(startIssueBranch(request(root, { state: 'closed' })), /issue #2 is not open/);
  assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main');
  assert.equal((await git('branch', '--list', 'feat/issue-2-consumer-work')).stdout.trim(), '');
});

test('an open Issue in the selected consumer creates a branch despite an ambient closed Issue', async (t) => {
  const { root, git } = await fixture(t);
  const before = (await git('rev-parse', 'HEAD')).stdout.trim();
  assert.equal(await startIssueBranch(request(root)), 'feat/issue-2-consumer-work');
  assert.equal((await git('branch', '--show-current')).stdout.trim(), 'feat/issue-2-consumer-work');
  assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), before);
});

test('wrong native identity, foreign Issue URLs and PR numbers preserve the consumer trunk', async (t) => {
  for (const scenario of [{ id: 9999 }, { issueUrl: 'https://github.com/example/other/issues/2' },
    { issueUrl: 'https://attacker.invalid/example/selected/issues/2' }, { pullRequest: true }]) {
    const { root, git } = await fixture(t);
    await assert.rejects(startIssueBranch(request(root, scenario)), /repository identity|source issue URL or Issue type/);
    assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main');
  }
});

test('missing tracking state, wrong origin and dirty files do not create a branch', async (t) => {
  for (const scenario of ['tracking', 'origin', 'dirty']) {
    const { root, git } = await fixture(t);
    if (scenario === 'tracking') await git('update-ref', '-d', 'refs/remotes/origin/main');
    if (scenario === 'origin') await git('remote', 'set-url', 'origin', 'https://github.com/example/other.git');
    if (scenario === 'dirty') await writeFile(path.join(root, 'local.txt'), 'preserve\n');
    await assert.rejects(startIssueBranch(request(root)), /inspect or mutate|origin does not match|uncommitted changes/);
    assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main');
  }
});

test('conflicting Git and GitHub environment selectors cannot redirect consumer work', async (t) => {
  for (const selectors of [{ GIT_DIR: '/unrelated/.git' }, { GH_REPO: 'example/other' },
    { GITHUB_REPOSITORY: 'example/other' }, { GH_HOST: 'github.example.invalid' }]) {
    const { root, git } = await fixture(t);
    const input = request(root); Object.assign(input.env, selectors);
    await assert.rejects(startIssueBranch(input), /selector/);
    assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main');
  }
});

test('a changed consumer and unavailable API never become branch-creation approval', async (t) => {
  for (const scenario of ['changed', 'unavailable']) {
    const { root, git } = await fixture(t);
    const input = request(root);
    const boundary = input.execFileImpl;
    input.execFileImpl = async (command, args, options) => {
      if (command === 'gh' && scenario === 'unavailable') throw new Error('synthetic private transport diagnostic');
      const response = await boundary(command, args, options);
      if (command === 'gh' && args.at(-1).endsWith('/issues/2')) {
        await writeFile(path.join(root, 'changed-during-read.txt'), 'preserve concurrent work\n');
      }
      return response;
    };
    await assert.rejects(startIssueBranch(input), (error) => {
      assert.match(error.message, scenario === 'changed' ? /uncommitted changes/ : /could not be read or verified/);
      assert.doesNotMatch(error.message, /private transport/);
      return true;
    });
    assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main');
  }
});

test('CLI usage requires an explicit root and native repository identity', async (t) => {
  const { root, git } = await fixture(t);
  const script = path.resolve(import.meta.dirname, '../scripts/start-issue-branch.mjs');
  await assert.rejects(execute(process.execPath, [script, 'feat', '2', 'consumer-work'], { cwd: root }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /--repository-root.*--repository.*--repository-id/);
    return true;
  });
  assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main');
});

test('successful Git inspection with unreadable-state diagnostics cannot declare a clean trunk', async (t) => {
  const { root, git } = await fixture(t);
  const input = request(root);
  const boundary = input.execFileImpl;
  let networkReads = 0;
  input.execFileImpl = async (command, args, options) => {
    if (command === 'gh') networkReads += 1;
    if (command === 'git' && args.includes('status')) {
      return { stdout: '', stderr: "warning: could not open directory 'private/': Permission denied\n" };
    }
    return boundary(command, args, options);
  };
  await assert.rejects(startIssueBranch(input), /inspect/);
  assert.equal(networkReads, 0);
  assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main');
  assert.equal((await git('branch', '--list', 'feat/issue-2-consumer-work')).stdout.trim(), '');
});
