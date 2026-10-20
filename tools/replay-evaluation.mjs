import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { primitiveContentDigest } from './primitive-content-digest.mjs';

const execFileAsync = promisify(execFile);
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHITECTURE_REPOSITORY = 'agentic-delivery-lab/agentic-delivery-architecture';
const PRIMITIVES_REPOSITORY = 'agentic-delivery-lab/agentic-delivery-primitives';
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const contracts = {
  'evaluation-dataset-schema': 'evaluations/contracts/evaluation-dataset.schema.json',
  'deterministic-grader-schema': 'evaluations/contracts/evaluation-deterministic-grader.schema.json',
  'semantic-grader-schema': 'evaluations/contracts/evaluation-semantic-grader.schema.json',
  'baseline-schema': 'evaluations/contracts/evaluation-baseline.schema.json',
  'comparator-schema': 'evaluations/contracts/evaluation-comparator.schema.json',
  'evaluation-catalog-schema': 'evaluations/contracts/evaluation-catalog.schema.json',
  'selection-policy-schema': 'evaluations/contracts/evaluation-selection-policy.schema.json',
};

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function formatErrors(validate) {
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
}

function check(valid, validate, label) {
  if (!valid) throw new Error(`${label} is invalid: ${formatErrors(validate)}`);
}

function ajv2020() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv;
}

async function git(root, args, encoding = 'utf8') {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    encoding,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

async function pinnedBlob(root, commit, relativePath) {
  if (!SHA.test(commit)) throw new Error(`Source pin for ${relativePath} must use a full 40-character commit SHA`);
  if (path.posix.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new Error(`Unsafe source pin path: ${relativePath}`);
  }
  return git(root, ['show', `${commit}:${relativePath}`], 'buffer');
}

function sourcePin(repository, commit, relativePath, digest) {
  return { repository, commit, path: relativePath, sha256: digest };
}

function githubBlob(repository, commit, relativePath) {
  return `https://github.com/${repository}/blob/${commit}/${relativePath}`;
}

function githubCommit(repository, commit) {
  return `https://github.com/${repository}/commit/${commit}`;
}

async function readJsonBlob(root, commit, relativePath) {
  const bytes = await pinnedBlob(root, commit, relativePath);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${relativePath} at ${commit} is not valid JSON: ${error.message}`);
  }
  return { bytes, value };
}

function artifact(catalog, id) {
  const found = catalog.artifacts.find((item) => item.id === id);
  if (!found) throw new Error(`Evaluation catalog is missing artifact ${id}`);
  return found;
}

function pinnedDefinition(catalog, id, repository, commit, definition) {
  const item = artifact(catalog, id);
  return {
    id,
    version: item.version,
    sourcePin: sourcePin(repository, commit, item.path, item.sha256),
    evaluator: definition.evaluator,
    independence: definition.independence,
    calibration: definition.calibration,
  };
}

function hasSameOrderedItems(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && expected.every((item, index) => actual[index] === item);
}

async function loadCheckedArtifact({ root, commit, catalog, id }) {
  const item = artifact(catalog, id);
  const bytes = await pinnedBlob(root, commit, item.path);
  const digest = sha256(bytes);
  if (digest !== item.sha256) {
    throw new Error(`Pinned artifact ${id} digest mismatch: expected ${item.sha256}, found ${digest}`);
  }
  return { item, bytes, digest };
}

async function loadPinnedValidator({ root, commit, catalog, id, scratchPath }) {
  const { item, bytes } = await loadCheckedArtifact({ root, commit, catalog, id });
  const modulePath = path.join(scratchPath, `${id}.mjs`);
  await writeFile(modulePath, bytes, { flag: 'wx' });
  const validatorModule = await import(pathToFileURL(modulePath).href);
  return { item, validatorModule };
}

function expectedResult(actual, expected) {
  return (actual ? 'pass' : 'fail') === expected;
}

async function runFixture(validatorName, validatorModule, input) {
  if (validatorName === 'branch-name') {
    try {
      validatorModule.validateBranchName(input);
      return {
        accepted: true,
        observation: 'The in-process branch-name validator accepted the synthetic input.',
      };
    } catch (error) {
      if (error instanceof validatorModule.BranchNameValidationError) {
        return {
          accepted: false,
          observation: 'The in-process branch-name validator rejected the synthetic input.',
        };
      }
      throw new Error(`Branch-name validator failed unexpectedly: ${error.message}`, { cause: error });
    }
  }
  if (validatorName !== 'source-issue') throw new Error(`Unsupported evaluation validator: ${validatorName}`);

  let adapterFault;
  let apiAdapterCalls = 0;
  let accepted;
  const expectedEndpoint = `https://api.github.com/repos/${input.repository}/issues/${input.issueNumber}`;
  const syntheticToken = 'offline-evaluation-token';
  try {
    await validatorModule.validateSourceIssue(input.issueNumber, {
      env: {
        GITHUB_REPOSITORY: input.repository,
        GITHUB_ACTIONS: 'true',
        GH_TOKEN: syntheticToken,
      },
      execFileImpl: async () => {
        adapterFault = new Error('GitHub Actions fixture attempted an unexpected CLI command.');
        throw adapterFault;
      },
      fetchImpl: async (endpoint, options) => {
        apiAdapterCalls += 1;
        if (endpoint !== expectedEndpoint
          || options?.headers?.Authorization !== `Bearer ${syntheticToken}`) {
          adapterFault = new Error('Synthetic API adapter received an unexpected request.');
          throw adapterFault;
        }
        return {
          ok: true,
          async json() {
            return { state: input.state.toLowerCase(), html_url: input.url };
          },
        };
      },
    });
    accepted = true;
  } catch (error) {
    if (adapterFault) throw new Error('Source-issue validator exceeded the synthetic API adapter boundary.', { cause: adapterFault });
    if (error instanceof validatorModule.SourceIssueValidationError) accepted = false;
    else throw new Error(`Source-issue validator failed unexpectedly: ${error.message}`, { cause: error });
  }
  if (apiAdapterCalls !== 1) throw new Error(`Source-issue validator used the synthetic API adapter ${apiAdapterCalls} times; expected exactly once.`);
  return {
    accepted,
    observation: `The synthetic GitHub Actions API adapter returned ${input.state} for ${input.repository}#${input.issueNumber}; the validator ${accepted ? 'accepted' : 'rejected'} the Issue.`,
  };
}

function measurement(metricId, value, unit, generatedAt, datasetUrl) {
  return {
    metricId,
    value,
    unit,
    observationWindow: 'Four synthetic offline fixture cases; no production observations.',
    observedAt: generatedAt,
    evidenceRefs: [datasetUrl],
  };
}

export function compareFixtureRates(candidateRate, baselineRate, direction) {
  const claim = candidateRate === baselineRate
    ? 'no-change'
    : ((candidateRate > baselineRate) === (direction === 'higher-is-better') ? 'improvement' : 'regression');
  return {
    claim,
    improvementHypothesis: {
      status: 'not-proposed',
      rationale: `Synthetic fixture pass rates: candidate ${candidateRate}; baseline ${baselineRate}. This small synthetic comparison does not establish a production improvement hypothesis.`,
    },
    regressionAssessment: {
      severity: claim === 'regression' ? 'moderate' : 'none',
      rationale: `Candidate deterministic fixture pass rate is ${candidateRate}; pinned baseline rate is ${baselineRate}. This statement applies only to this synthetic fixture set.`,
    },
  };
}

export async function replayEvaluation({
  root = rootDefault,
  architectureSchemaPath = process.env.ARCHITECTURE_REPORT_SCHEMA
    ? path.resolve(root, process.env.ARCHITECTURE_REPORT_SCHEMA)
    : path.resolve(root, '../agentic-delivery-architecture/architecture/contracts/evaluation-report.schema.json'),
  generatedAt,
  runStartedAt,
} = {}) {
  const actualRunStartedAt = runStartedAt ?? generatedAt ?? new Date().toISOString();
  const scratchPath = await mkdtemp(path.join(tmpdir(), 'primitives-offline-evaluation-'));
  try {
  const release = JSON.parse(await readFile(path.join(root, 'manifests/primitive-release.json'), 'utf8'));
  if (!SHA.test(release.sourceCommit ?? '')) throw new Error('Primitive release must pin a full 40-character source commit.');
  if (!SHA.test(release.architecture?.sourceCommit ?? '')) throw new Error('Primitive release must pin a full Architecture source commit.');

  const candidateCommit = release.sourceCommit;
  const pinnedContentDigest = await primitiveContentDigest(root, candidateCommit);
  if (pinnedContentDigest !== release.contentSha256) {
    throw new Error(`Primitive release content digest mismatch: expected ${release.contentSha256}, found ${pinnedContentDigest}`);
  }

  const catalogBytes = await pinnedBlob(root, candidateCommit, 'evaluations/catalog.json');
  const workingCatalogBytes = await readFile(path.join(root, 'evaluations/catalog.json'));
  if (!catalogBytes.equals(workingCatalogBytes)) {
    throw new Error('Working evaluation catalog differs from the Primitive release source commit.');
  }
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  const catalogAjv = ajv2020();
  const catalogSchemaBytes = await pinnedBlob(root, candidateCommit, contracts['evaluation-catalog-schema']);
  const catalogSchema = JSON.parse(catalogSchemaBytes.toString('utf8'));
  const validateCatalog = catalogAjv.compile(catalogSchema);
  check(validateCatalog(catalog), validateCatalog, 'Evaluation catalog');
  const catalogSchemaPath = path.posix.normalize(path.posix.join('evaluations', catalog.$schema ?? ''));
  if (catalogSchemaPath !== contracts['evaluation-catalog-schema']) {
    throw new Error(`Evaluation catalog must identify its pinned schema at ${contracts['evaluation-catalog-schema']}`);
  }

  if (catalog.repository !== PRIMITIVES_REPOSITORY) throw new Error('Evaluation catalog repository does not match this Primitive repository.');
  if (catalog.reportSchema.repository !== ARCHITECTURE_REPOSITORY) throw new Error('Report schema pin is not owned by Architecture Authority.');
  if (catalog.reportSchema.commit !== release.architecture.sourceCommit) throw new Error('Report schema commit must match the Primitive release Architecture pin.');

  const catalogArtifacts = new Map();
  for (const entry of catalog.artifacts) {
    if (catalogArtifacts.has(entry.id)) throw new Error(`Evaluation catalog repeats artifact id ${entry.id}`);
    if (!SHA256.test(entry.sha256)) throw new Error(`Evaluation artifact ${entry.id} must pin a SHA-256 digest.`);
    catalogArtifacts.set(entry.id, await loadCheckedArtifact({ root, commit: candidateCommit, catalog, id: entry.id }));
  }
  for (const id of ['replay-runner', 'content-digest-runner']) {
    const pinned = catalogArtifacts.get(id);
    const working = await readFile(path.join(root, pinned.item.path));
    if (!working.equals(pinned.bytes)) throw new Error(`Working evaluator dependency ${id} differs from its pinned release source.`);
  }

  const localSchemas = new Map();
  const localAjv = ajv2020();
  for (const [schemaArtifactId, schemaPath] of Object.entries(contracts)) {
    const { bytes } = catalogArtifacts.get(schemaArtifactId);
    const schema = JSON.parse(bytes.toString('utf8'));
    localSchemas.set(schemaArtifactId, { path: schemaPath, schema, validate: localAjv.compile(schema) });
  }

  const instances = [
    ['evaluation-dataset', 'evaluation-dataset-schema'],
    ['dataset-selection-policy', 'selection-policy-schema'],
    ['deterministic-grader', 'deterministic-grader-schema'],
    ['semantic-rubric', 'semantic-grader-schema'],
    ['synthetic-baseline', 'baseline-schema'],
    ['deterministic-pass-rate-comparator', 'comparator-schema'],
  ];
  const values = new Map();
  for (const [artifactId, schemaId] of instances) {
    const { item, bytes } = catalogArtifacts.get(artifactId);
    const value = JSON.parse(bytes.toString('utf8'));
    const schema = localSchemas.get(schemaId);
    const declaredSchemaPath = path.posix.normalize(path.posix.join(path.posix.dirname(item.path), value.$schema ?? ''));
    if (declaredSchemaPath !== schema.path) throw new Error(`${item.path} does not point at its pinned schema ${schema.path}`);
    check(schema.validate(value), schema.validate, item.path);
    values.set(artifactId, value);
  }

  const dataset = values.get('evaluation-dataset');
  const selectionPolicy = values.get('dataset-selection-policy');
  const grader = values.get('deterministic-grader');
  const semanticRubric = values.get('semantic-rubric');
  const baseline = values.get('synthetic-baseline');
  const comparator = values.get('deterministic-pass-rate-comparator');
  if (grader.candidateValidators.some((name) => !dataset.cases.some((fixture) => fixture.validator === name))) {
    throw new Error('Deterministic grader names a validator with no dataset cases.');
  }
  if (baseline.sourceCommit !== 'e4933566fbf5b0f593830f8933f18fbd21024fa7') {
    throw new Error('The current evaluation baseline must remain pinned to the immutable Primitives main snapshot.');
  }
  if (baseline.sourcePins.some((pin) => pin.commit !== baseline.sourceCommit || pin.repository !== PRIMITIVES_REPOSITORY)) {
    throw new Error('Every baseline validator pin must use the baseline source commit and Primitives repository.');
  }
  const datasetCaseIds = dataset.cases.map(({ id }) => id);
  if (selectionPolicy.datasetId !== dataset.id) throw new Error('Selection policy must name the exact pinned evaluation dataset.');
  if (selectionPolicy.partition !== 'synthetic' || dataset.classification !== 'synthetic') {
    throw new Error('This offline replay only accepts a selection policy and dataset classified as synthetic.');
  }
  if (selectionPolicy.sampling !== 'census') throw new Error('This offline replay requires a pre-registered census selection policy.');
  if (Date.parse(selectionPolicy.registeredAt) > Date.parse(actualRunStartedAt)) {
    throw new Error('Selection policy must be registered before the evaluation run starts.');
  }
  if (!hasSameOrderedItems(selectionPolicy.eligibleCaseIds, datasetCaseIds)) {
    throw new Error('Selection policy eligible case IDs and order must exactly match the pinned dataset.');
  }
  if (!hasSameOrderedItems(selectionPolicy.includedCaseIds, selectionPolicy.eligibleCaseIds)) {
    throw new Error('Census selection must include every eligible case without result-based filtering.');
  }
  if (selectionPolicy.exclusions.some(({ caseId }) => (
    !selectionPolicy.eligibleCaseIds.includes(caseId) || selectionPolicy.includedCaseIds.includes(caseId)
  ))) {
    throw new Error('An excluded case cannot also be included in the evaluation selection.');
  }

  const { item: candidateBranch, validatorModule: candidateBranchModule } = await loadPinnedValidator({
    root, commit: candidateCommit, catalog, id: 'candidate-branch-validator', scratchPath,
  });
  const { item: candidateIssue, validatorModule: candidateIssueModule } = await loadPinnedValidator({
    root, commit: candidateCommit, catalog, id: 'candidate-source-issue-validator', scratchPath,
  });
  const baselineModules = new Map();
  for (const pin of baseline.sourcePins) {
    const bytes = await pinnedBlob(root, baseline.sourceCommit, pin.path);
    const digest = sha256(bytes);
    if (digest !== pin.sha256) throw new Error(`Baseline source pin ${pin.id} digest mismatch: expected ${pin.sha256}, found ${digest}`);
    const modulePath = path.join(scratchPath, `${pin.id}.mjs`);
    await writeFile(modulePath, bytes, { flag: 'wx' });
    baselineModules.set(pin.id, await import(pathToFileURL(modulePath).href));
  }

  const reportSchemaBytes = await readFile(architectureSchemaPath);
  if (sha256(reportSchemaBytes) !== catalog.reportSchema.sha256) {
    throw new Error(`Pinned Architecture report schema digest mismatch at ${architectureSchemaPath}`);
  }
  const reportSchema = JSON.parse(reportSchemaBytes.toString('utf8'));
  const reportAjv = ajv2020();
  const validateReport = reportAjv.compile(reportSchema);
  const reportSchemaVersion = reportSchema.properties?.contractVersion?.const;
  if (!reportSchemaVersion) throw new Error('Pinned Architecture report schema has no contract version.');

  const datasetArtifact = artifact(catalog, 'evaluation-dataset');
  const datasetUrl = githubBlob(PRIMITIVES_REPOSITORY, candidateCommit, datasetArtifact.path);
  const candidateChecks = [];
  const baselineChecks = [];
  for (const fixture of dataset.cases) {
    const candidateModule = fixture.validator === 'branch-name' ? candidateBranchModule : candidateIssueModule;
    const candidateResult = await runFixture(fixture.validator, candidateModule, fixture.input);
    const candidateMatched = expectedResult(candidateResult.accepted, fixture.expectedOutcome);
    candidateChecks.push({
      checkId: `candidate.${fixture.validator}.${fixture.id}`,
      outcome: candidateMatched ? 'pass' : 'fail',
      details: `Expected ${fixture.expectedOutcome}; ${candidateResult.observation}`,
      ...(candidateMatched ? {} : { failureClass: 'correctness-regression' }),
      evidenceRefs: [`${datasetUrl}#${fixture.id}`],
    });

    const baselineModule = fixture.validator === 'branch-name'
      ? baselineModules.get('baseline-branch-name-validator')
      : baselineModules.get('baseline-source-issue-validator');
    if (!baselineModule) throw new Error(`Baseline does not pin a ${fixture.validator} validator.`);
    const baselineResult = await runFixture(fixture.validator, baselineModule, fixture.input);
    baselineChecks.push(expectedResult(baselineResult.accepted, fixture.expectedOutcome));
  }

  const passed = candidateChecks.filter(({ outcome }) => outcome === 'pass').length;
  const baselinePassed = baselineChecks.filter(Boolean).length;
  const candidateRate = passed / dataset.cases.length;
  const baselineRate = baselinePassed / dataset.cases.length;
  const reportGeneratedAt = generatedAt ?? new Date().toISOString();
  if (Date.parse(actualRunStartedAt) > Date.parse(reportGeneratedAt)) {
    throw new Error('Evaluation run start cannot be later than its generated report time.');
  }
  const comparison = compareFixtureRates(candidateRate, baselineRate, comparator.direction);

  const pinFor = (id) => {
    const item = artifact(catalog, id);
    return sourcePin(PRIMITIVES_REPOSITORY, candidateCommit, item.path, item.sha256);
  };
  const baselinePinFor = (pin) => sourcePin(pin.repository, pin.commit, pin.path, pin.sha256);
  const baselineArtifact = artifact(catalog, 'synthetic-baseline');
  const comparatorArtifact = artifact(catalog, 'deterministic-pass-rate-comparator');
  const catalogDigest = sha256(catalogBytes);
  const baselineMeasurement = measurement(comparator.metricId, baselineRate, comparator.unit, reportGeneratedAt, datasetUrl);
  const candidateMeasurement = measurement(comparator.metricId, candidateRate, comparator.unit, reportGeneratedAt, datasetUrl);
  const reportSchemaUrl = `https://github.com/${catalog.reportSchema.repository}/blob/${catalog.reportSchema.commit}/${catalog.reportSchema.path}`;
  const subjectArtifact = artifact(catalog, 'candidate-capabilities-catalog');
  const selectionPolicyUrl = githubBlob(PRIMITIVES_REPOSITORY, candidateCommit, artifact(catalog, 'dataset-selection-policy').path);
  const reportCases = dataset.cases.map((fixture, index) => {
    const checkResult = candidateChecks[index];
    return {
      caseId: fixture.id,
      task: fixture.task,
      stimulus: fixture.stimulus,
      expectedOutcome: {
        description: fixture.expectedOutcomeDescription,
        acceptanceCriteria: fixture.acceptanceCriteria,
      },
      observedOutcome: checkResult.details,
      outcome: checkResult.outcome,
      ...(checkResult.failureClass ? { failureClass: checkResult.failureClass } : {}),
      evidenceRefs: checkResult.evidenceRefs,
    };
  });

  const report = {
    $schema: reportSchemaUrl,
    contractVersion: reportSchemaVersion,
    reportId: `offline:${dataset.id}:${candidateCommit}:${baseline.sourceCommit}`,
    runStartedAt: actualRunStartedAt,
    generatedAt: reportGeneratedAt,
    classification: 'synthetic',
    evaluationMode: 'offline',
    layer: 'agent-capability',
    subject: {
      layer: 'agent-capability',
      id: 'repository-delivery-validation',
      version: subjectArtifact.version,
      sourcePin: pinFor('candidate-capabilities-catalog'),
    },
    dataset: {
      id: dataset.id,
      version: dataset.version,
      sourcePin: pinFor('evaluation-dataset'),
      partition: selectionPolicy.partition,
      selection: {
        policyPin: pinFor('dataset-selection-policy'),
        registeredAt: selectionPolicy.registeredAt,
        sampling: selectionPolicy.sampling,
        eligiblePopulation: selectionPolicy.eligiblePopulation,
        inclusionCriteria: selectionPolicy.inclusionCriteria,
        exclusions: selectionPolicy.exclusions,
      },
      integrity: {
        contaminationStatus: 'unknown',
        assessedAt: reportGeneratedAt,
        provenanceBasis: 'The dataset is source-controlled synthetic test data; no independent benchmark-contamination assessment has been performed.',
        evidenceRefs: [datasetUrl, selectionPolicyUrl],
      },
      caseIds: selectionPolicy.includedCaseIds,
    },
    cases: reportCases,
    dependencies: [
      {
        id: 'evaluation-catalog',
        version: catalog.version,
        sourcePin: sourcePin(PRIMITIVES_REPOSITORY, candidateCommit, 'evaluations/catalog.json', catalogDigest),
      },
      {
        id: 'primitive-content-digest',
        version: artifact(catalog, 'content-digest-runner').version,
        sourcePin: pinFor('content-digest-runner'),
      },
      {
        id: candidateBranch.id,
        version: candidateBranch.version,
        sourcePin: pinFor('candidate-branch-validator'),
      },
      {
        id: candidateIssue.id,
        version: candidateIssue.version,
        sourcePin: pinFor('candidate-source-issue-validator'),
      },
      ...baseline.sourcePins.map((pin) => ({ id: pin.id, version: pin.version, sourcePin: baselinePinFor(pin) })),
    ],
    graders: {
      deterministic: pinnedDefinition(catalog, 'replay-runner', PRIMITIVES_REPOSITORY, candidateCommit, grader),
      semantic: pinnedDefinition(catalog, 'semantic-rubric', PRIMITIVES_REPOSITORY, candidateCommit, semanticRubric),
    },
    results: {
      deterministicChecks: candidateChecks,
      semanticJudgments: [],
    },
    baseline: {
      status: 'measured',
      definitionPin: sourcePin(PRIMITIVES_REPOSITORY, candidateCommit, baselineArtifact.path, baselineArtifact.sha256),
      measurement: baselineMeasurement,
    },
    comparison: {
      claim: comparison.claim,
      comparator: {
        id: comparator.id,
        version: comparator.version,
        sourcePin: sourcePin(PRIMITIVES_REPOSITORY, candidateCommit, comparatorArtifact.path, comparatorArtifact.sha256),
        method: comparator.method,
        direction: comparator.direction,
      },
      candidateMeasurement,
    },
    improvementHypothesis: comparison.improvementHypothesis,
    uncertainty: {
      level: 'high',
      summary: 'The comparison covers only four synthetic fixtures and has not received independent semantic review.',
      factors: [
        'The dataset is synthetic and does not represent production traffic or customer data.',
        'The source-Issue interaction uses an injected local adapter and makes no GitHub API call.',
        'No independent reviewer has completed the manual semantic rubric.',
      ],
    },
    review: {
      status: 'pending',
      reviewerId: null,
      rationale: 'Independent semantic review remains pending; the manual rubric is never invoked by replay.',
    },
    regressionAssessment: comparison.regressionAssessment,
    evidence: [
      { kind: 'source', ref: githubBlob(PRIMITIVES_REPOSITORY, candidateCommit, subjectArtifact.path) },
      { kind: 'dataset', ref: datasetUrl },
      { kind: 'result', ref: githubCommit(PRIMITIVES_REPOSITORY, candidateCommit) },
      { kind: 'baseline', ref: githubCommit(PRIMITIVES_REPOSITORY, baseline.sourceCommit) },
      { kind: 'review', ref: catalog.ownerIssue },
      { kind: 'source', ref: reportSchemaUrl },
    ],
    recommendation: {
      action: 'owner-issue',
      ownerIssue: catalog.ownerIssue,
      rationale: 'Route the synthetic result and its limitations to the existing owner Issue for human prioritization; replay itself makes no repository or Project changes.',
    },
    limitations: [
      'This is a synthetic offline evaluation; no live production or product outcome is claimed.',
      'The semantic rubric is pinned but manual-only; semanticJudgments remains empty until a reviewer records independent evidence.',
      'Adoption remains gated on Primitive Issue #2 ADR impact mapping, independent semantic review, and approved release pins.',
      'The report records evidence and an existing owner Issue; it cannot authorize work, create an Issue, change policy, activate a participant, approve or merge a pull request, or change Project configuration.',
    ],
  };

  check(validateReport(report), validateReport, 'Evaluation report');
  return { report, candidateCommit, reportSchemaValid: true };
  } finally {
    await rm(scratchPath, { recursive: true });
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const mode = process.argv[2] ?? '--check';
  if (!['--check', '--report'].includes(mode)) {
    process.stderr.write('Usage: node tools/replay-evaluation.mjs [--check|--report]\n');
    process.exitCode = 2;
  } else {
    try {
      const result = await replayEvaluation();
      if (mode === '--report') process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
      else process.stdout.write(`Offline evaluation check passed: ${result.report.dataset.caseIds.length} synthetic cases; ${result.report.comparison.claim}; report conforms to Architecture contract ${result.report.contractVersion}.\n`);
    } catch (error) {
      process.stderr.write(`Offline evaluation check failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
