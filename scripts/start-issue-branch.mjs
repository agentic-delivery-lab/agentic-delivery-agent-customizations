// agentic-primitive: {"id":"issue-branch-starter","kind":"capability","enforcement":"deterministic","decisionIds":["ADR-0007"],"domains":["agentic-delivery-governance"],"adrs":["ADR-0007"]}
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateBranchName } from '../validators/repository-delivery/validate-branch-name.mjs';
import { validateBoundSourceIssue } from '../validators/repository-delivery/validate-source-issue.mjs';

// Extracted from Control Plane d873ab374ca47d7770ffae34d3b436b94b26cee9
// scripts/start-issue-branch.mjs, with explicit consumer binding and closed reads.

const execute = promisify(execFile);
export class BranchStartError extends Error {
  constructor(message, exitCode = 1) { super(message); this.name = 'BranchStartError'; this.exitCode = exitCode; }
}

// This capability creates and switches a branch. Its caller must supply an
// admitted consumer context and own workspace coordination; it installs none.
export async function startIssueBranch({ branchType, issueNumber, summary,
  repositoryRoot, repositoryIdentity, env = process.env, execFileImpl = execute } = {}) {
  if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) {
    throw new BranchStartError('Branch start requires an explicit absolute consumer repository root.', 2);
  }
  if (Object.keys(env).some((key) => key.startsWith('GIT_'))) {
    throw new BranchStartError('Branch start rejects ambient Git selectors; use the admitted consumer environment.');
  }
  const root = await realpath(repositoryRoot);
  const name = `${branchType}/issue-${issueNumber}-${summary}`;
  validateBranchName(name);
  const run = async (args, { mutation = false } = {}) => {
    try {
      const { stdout, stderr } = await execFileImpl('git', ['-C', root, ...args], {
        cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      if (!mutation && stderr) throw new Error('Git inspection returned uncertain diagnostics.');
      return stdout.trim();
    } catch { throw new BranchStartError('Branch start could not inspect or mutate the selected Git repository.'); }
  };
  const originNames = repositoryIdentity && typeof repositoryIdentity.name === 'string'
    ? [`https://github.com/${repositoryIdentity.name}`, `git@github.com:${repositoryIdentity.name}`,
      `ssh://git@github.com/${repositoryIdentity.name}`] : [];
  async function inspect() {
    if (await realpath(await run(['rev-parse', '--show-toplevel'])) !== root) throw new BranchStartError('Selected root is not the consumer repository root.');
    if (await run(['branch', '--show-current']) !== 'main') throw new BranchStartError('Branch start requires the consumer main branch.');
    if (await run(['status', '--porcelain'])) throw new BranchStartError('Consumer main has uncommitted changes.');
    const origin = (await run(['remote', 'get-url', 'origin'])).replace(/\.git$/, '');
    if (!originNames.some((value) => value.toLowerCase() === origin.toLowerCase())) throw new BranchStartError('Consumer origin does not match the selected native repository identity.');
    const head = await run(['rev-parse', '--verify', 'HEAD^{commit}']);
    const tracking = await run(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
    if (head !== tracking) throw new BranchStartError('Consumer main is not synchronized with origin/main.');
    return head;
  }
  const head = await inspect();
  await validateBoundSourceIssue(issueNumber, { repositoryRoot: root, repositoryIdentity, env, execFileImpl });
  if (await inspect() !== head) throw new BranchStartError('Consumer Git state changed during source Issue verification.');
  await run(['switch', '-c', name, head], { mutation: true });
  return name;
}

const usage = 'Usage: start-issue-branch.mjs --repository-root <absolute-root> --repository <owner/repo> --repository-id <native-id> <type> <issue-number> <summary>';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 9 || args[0] !== '--repository-root' || args[2] !== '--repository' || args[4] !== '--repository-id') {
    process.stderr.write(`${usage}\n`); process.exitCode = 2;
  } else {
    try {
      const branch = await startIssueBranch({ repositoryRoot: args[1], repositoryIdentity: { name: args[3], id: Number(args[5]) },
        branchType: args[6], issueNumber: args[7], summary: args[8] });
      process.stdout.write(`Created and switched to ${branch}.\n`);
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = error.exitCode ?? 1; }
  }
}
