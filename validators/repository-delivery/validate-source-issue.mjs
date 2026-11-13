// agentic-primitive: {"id":"source-issue-validator","kind":"validator","enforcement":"deterministic","decisionIds":["ADR-0007"],"domains":["agentic-delivery-governance"],"adrs":["ADR-0007"]}

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class SourceIssueValidationError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'SourceIssueValidationError';
    this.exitCode = exitCode;
  }
}

function fail(message) {
  return new SourceIssueValidationError(`Source issue check failed: ${message}`);
}

function validIssueNumber(value) {
  return /^[1-9][0-9]*$/.test(value ?? '');
}

function validRepository(repository) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
}

// Consumer profiles supply this context; Issue text cannot select a repository.
// Keep the historical validateSourceIssue interface for existing consumers.
export async function validateBoundSourceIssue(issueNumber, {
  repositoryRoot, repositoryIdentity, env = process.env, execFileImpl = execFileAsync,
} = {}) {
  if (!validIssueNumber(issueNumber) || !Number.isSafeInteger(Number(issueNumber))
    || typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)
    || !repositoryIdentity || Object.keys(repositoryIdentity).sort().join(',') !== 'id,name'
    || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repositoryIdentity.name)
    || !Number.isSafeInteger(repositoryIdentity.id) || repositoryIdentity.id < 1) {
    throw new SourceIssueValidationError('Source issue check requires an explicit consumer root, native repository identity and positive issue number.', 2);
  }
  const { name, id } = repositoryIdentity;
  for (const key of ['GH_REPO', 'GITHUB_REPOSITORY']) {
    const selected = env[key]?.replace(/^github\.com\//i, '');
    if (selected && selected.toLowerCase() !== name.toLowerCase()) throw fail('conflicting repository selector.');
  }
  if (env.GH_HOST && env.GH_HOST.toLowerCase() !== 'github.com') throw fail('conflicting GitHub host selector.');
  async function read(endpoint) {
    try {
      const { stdout } = await execFileImpl('gh', ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], {
        cwd: repositoryRoot, env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch {
      throw fail('selected GitHub source could not be read or verified.');
    }
  }
  const repository = await read(`repos/${name}`);
  if (repository.id !== id || typeof repository.full_name !== 'string'
    || repository.full_name.toLowerCase() !== name.toLowerCase()) throw fail('native repository identity does not match the consumer.');
  const issue = await read(`repos/${name}/issues/${issueNumber}`);
  const url = `https://github.com/${repository.full_name}/issues/${issueNumber}`;
  if (issue.number !== Number(issueNumber) || issue.html_url !== url
    || Object.hasOwn(issue, 'pull_request')) throw fail('selected source issue URL or Issue type does not match the consumer.');
  if (issue.state !== 'open') throw fail(`issue #${issueNumber} is not open.`);
  return Object.freeze({ issueNumber, repository: repository.full_name, repositoryId: id, url });
}

async function localRepository(execFileImpl, env) {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  try {
    const { stdout } = await execFileImpl(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { env, encoding: 'utf8', windowsHide: true },
    );
    return stdout.trim();
  } catch {
    throw fail('unable to determine the current GitHub repository.');
  }
}

async function readLocalIssue(execFileImpl, env, issueNumber, repository) {
  try {
    const { stdout } = await execFileImpl(
      'gh',
      [
        'issue', 'view', issueNumber,
        '--repo', repository,
        '--json', 'state,url',
        '--jq', '[.state, .url] | @tsv',
      ],
      { env, encoding: 'utf8', windowsHide: true },
    );
    const [state, url] = stdout.trim().split(/\r?\n/, 1)[0].split('\t');
    return { state, url };
  } catch {
    throw fail(`issue #${issueNumber} could not be read in ${repository}.`);
  }
}

async function readApiIssue(fetchImpl, env, issueNumber, repository) {
  if (!env.GH_TOKEN) {
    throw fail('GitHub Actions did not provide an issue-read token.');
  }
  const endpoint = `https://api.github.com/repos/${repository}/issues/${issueNumber}`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        Authorization: `Bearer ${env.GH_TOKEN}`,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return { state: String(payload.state ?? '').toUpperCase(), url: payload.html_url };
  } catch {
    throw fail(`issue #${issueNumber} could not be read in ${repository}.`);
  }
}

export async function validateSourceIssue(
  issueNumber,
  {
    env = process.env,
    execFileImpl = execFileAsync,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (!validIssueNumber(issueNumber)) {
    throw new SourceIssueValidationError('Usage: validate-source-issue.mjs <open-issue-number>', 2);
  }

  const repository = await localRepository(execFileImpl, env);
  if (!validRepository(repository)) throw fail('invalid repository identifier.');

  const issue = env.GITHUB_ACTIONS === 'true'
    ? await readApiIssue(fetchImpl, env, issueNumber, repository)
    : await readLocalIssue(execFileImpl, env, issueNumber, repository);

  if (issue.state !== 'OPEN') throw fail(`issue #${issueNumber} is not open.`);
  if (typeof issue.url !== 'string' || !issue.url.endsWith(`/issues/${issueNumber}`)) {
    throw fail(`#${issueNumber} is not a GitHub Issue in ${repository}.`);
  }
  return { issueNumber, repository, url: issue.url };
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  if (process.argv.length !== 3) {
    process.stderr.write(`Usage: ${path.basename(process.argv[1])} <open-issue-number>\n`);
    process.exitCode = 2;
  } else {
    try {
      const result = await validateSourceIssue(process.argv[2]);
      process.stdout.write(`Source issue #${result.issueNumber} is open in ${result.repository}.\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode ?? 1;
    }
  }
}
