import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { compareFixtureRates, replayEvaluation } from '../tools/replay-evaluation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const architectureSchemaPath = path.resolve(
  root,
  process.env.ARCHITECTURE_REPORT_SCHEMA
    ?? path.join(process.env.ARCHITECTURE_AUTHORITY_ROOT ?? '../agentic-delivery-architecture', 'architecture/contracts/evaluation-report.schema.json'),
);
const runStartedAt = '2026-10-10T23:21:15.000Z';
const generatedAt = '2026-10-10T23:21:16.000Z';

test('offline evaluation replay validates pinned artifacts and returns reproducible evidence', async () => {
  const first = await replayEvaluation({ root, architectureSchemaPath, runStartedAt, generatedAt });
  const second = await replayEvaluation({ root, architectureSchemaPath, runStartedAt, generatedAt });

  assert.deepEqual(first.report, second.report);
  assert.equal(first.report.contractVersion, '2.0.0');
  assert.equal(first.report.classification, 'synthetic');
  assert.equal(first.report.evaluationMode, 'offline');
  assert.equal(first.report.runStartedAt, runStartedAt);
  assert.equal(first.report.dataset.caseIds.length, 4);
  assert.equal(first.report.dataset.partition, 'synthetic');
  assert.equal(first.report.dataset.selection.sampling, 'census');
  assert.equal(first.report.dataset.selection.policyPin.path, 'evaluations/plans/repository-delivery-validation-selection.json');
  assert.equal(first.report.dataset.selection.policyPin.commit, first.candidateCommit);
  assert.match(first.report.dataset.selection.policyPin.sha256, /^[0-9a-f]{64}$/);
  assert.ok(first.report.dataset.selection.registeredAt < runStartedAt);
  assert.equal(first.report.dataset.integrity.contaminationStatus, 'unknown');
  assert.equal(first.report.cases.length, first.report.dataset.caseIds.length);
  assert.deepEqual(first.report.cases.map(({ caseId }) => caseId), first.report.dataset.caseIds);
  assert.ok(first.report.cases.every(({ task, stimulus, expectedOutcome, observedOutcome, evidenceRefs }) => (
    task && stimulus && expectedOutcome.description && expectedOutcome.acceptanceCriteria.length > 0
      && observedOutcome && evidenceRefs.length > 0
  )));
  const sourceIssueCases = first.report.cases.filter(({ caseId }) => caseId.includes('source-issue'));
  assert.equal(sourceIssueCases.length, 2);
  assert.ok(sourceIssueCases.every(({ observedOutcome }) => observedOutcome.includes('synthetic GitHub Actions API adapter')));
  assert.equal(first.report.results.deterministicChecks.length, 4);
  assert.deepEqual(
    first.report.cases.map(({ outcome }) => outcome),
    first.report.results.deterministicChecks.map(({ outcome }) => outcome),
  );
  assert.deepEqual(first.report.results.semanticJudgments, []);
  assert.equal(first.report.graders.deterministic.evaluator.kind, 'deterministic-tool');
  assert.equal(first.report.graders.deterministic.independence.relation, 'not-independent');
  assert.equal(first.report.graders.deterministic.calibration.status, 'not-applicable');
  assert.equal(first.report.graders.semantic.independence.relation, 'unknown');
  assert.equal(first.report.graders.semantic.calibration.status, 'not-applicable');
  assert.equal(first.report.improvementHypothesis.status, 'not-proposed');
  assert.match(first.report.improvementHypothesis.rationale, /candidate 1; baseline 1/);
  assert.equal(first.report.baseline.status, 'measured');
  assert.equal(first.report.comparison.claim, 'no-change');
  assert.equal(first.report.review.status, 'pending');
  assert.equal(first.report.recommendation.action, 'owner-issue');
  assert.equal(first.report.recommendation.ownerIssue, 'https://github.com/agentic-delivery-lab/agentic-delivery-primitives/issues/3');
  assert.equal(
    first.report.$schema,
    'https://github.com/agentic-delivery-lab/agentic-delivery-architecture/blob/7b1d21462f70c411e75ae67ce80dcf688c9973e8/architecture/contracts/evaluation-report.schema.json',
  );
  assert.deepEqual(first.report.results.deterministicChecks.map(({ outcome }) => outcome), [
    'pass', 'pass', 'pass', 'pass',
  ]);

  const candidatePins = first.report.dependencies.filter(({ id }) => id.startsWith('candidate-'));
  const baselinePins = first.report.dependencies.filter(({ id }) => id.startsWith('baseline-'));
  assert.equal(candidatePins.length, 2);
  assert.equal(baselinePins.length, 2);
  assert.ok(candidatePins.every(({ sourcePin }) => sourcePin.commit === first.candidateCommit));
  assert.ok(baselinePins.every(({ sourcePin }) => sourcePin.commit === 'e4933566fbf5b0f593830f8933f18fbd21024fa7'));
  assert.equal(first.reportSchemaValid, true);
});

test('deterministic grader metadata is pinned to its definition and the runner is a dependency', async () => {
  const { report, candidateCommit } = await replayEvaluation({ root, architectureSchemaPath, runStartedAt, generatedAt });
  const bytes = await readFile(path.join(root, 'evaluations/graders/deterministic-grader.json'));
  const definition = JSON.parse(bytes);
  assert.equal(report.graders.deterministic.id, 'deterministic-grader');
  assert.equal(report.graders.deterministic.version, definition.version);
  assert.equal(report.graders.deterministic.sourcePin.path, 'evaluations/graders/deterministic-grader.json');
  assert.equal(report.graders.deterministic.sourcePin.commit, candidateCommit);
  assert.equal(report.graders.deterministic.sourcePin.sha256, createHash('sha256').update(bytes).digest('hex'));
  for (const field of ['evaluator', 'independence', 'calibration']) {
    assert.deepEqual(report.graders.deterministic[field], definition[field]);
  }
  const runner = report.dependencies.find(({ id }) => id === 'replay-runner');
  assert.ok(runner);
  assert.equal(runner.sourcePin.path, 'tools/replay-evaluation.mjs');
  assert.equal(runner.sourcePin.commit, candidateCommit);
  const runnerBytes = await readFile(path.join(root, runner.sourcePin.path));
  assert.equal(runner.sourcePin.sha256, createHash('sha256').update(runnerBytes).digest('hex'));
});

test('local replay honors the documented Architecture root and still rejects tampered schema bytes', async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'evaluation-architecture-root-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const schema = path.join(fixture, 'architecture/contracts/evaluation-report.schema.json');
  await mkdir(path.dirname(schema), { recursive: true });
  const bytes = await readFile(architectureSchemaPath);
  await writeFile(schema, Buffer.concat([bytes, Buffer.from('\n')]));
  const env = { ...process.env, ARCHITECTURE_AUTHORITY_ROOT: fixture };
  delete env.ARCHITECTURE_REPORT_SCHEMA;
  const exec = promisify(execFile);
  await assert.rejects(
    exec(process.execPath, ['tools/replay-evaluation.mjs', '--check'], { cwd: root, env }),
    (error) => error.code === 1 && /report schema digest mismatch/i.test(error.stderr),
  );
  await writeFile(schema, bytes);
  const result = await exec(process.execPath, ['tools/replay-evaluation.mjs', '--check'], { cwd: root, env });
  assert.match(result.stdout, /no-change/);
});

test('offline evaluation rejects a selection policy registered after the run starts', async () => {
  await assert.rejects(
    replayEvaluation({
      root,
      architectureSchemaPath,
      runStartedAt: '2026-10-10T23:21:13.000Z',
      generatedAt,
    }),
    /Selection policy must be registered before the evaluation run starts/,
  );
});

for (const [candidate, baseline, direction, claim] of [
  [0.5, 1, 'higher-is-better', 'regression'],
  [1, 0.5, 'higher-is-better', 'improvement'],
  [0.5, 1, 'lower-is-better', 'improvement'],
  [1, 0.5, 'lower-is-better', 'regression'],
  [1, 1, 'higher-is-better', 'no-change'],
]) {
  test(`comparison describes ${candidate}/${baseline} with ${direction} without inventing a hypothesis`, () => {
    const comparison = compareFixtureRates(candidate, baseline, direction);
    assert.equal(comparison.claim, claim);
    assert.equal(comparison.improvementHypothesis.status, 'not-proposed');
    assert.ok(comparison.improvementHypothesis.rationale.includes(`candidate ${candidate}; baseline ${baseline}`));
    assert.doesNotMatch(comparison.improvementHypothesis.rationale, /produce the same result/);
    assert.equal(comparison.regressionAssessment.severity, claim === 'regression' ? 'moderate' : 'none');
  });
}
