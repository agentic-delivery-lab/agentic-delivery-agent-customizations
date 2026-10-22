import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  validateArchitecturePin,
  validateDecisionImpactCoverage,
  validatePrimitiveReleaseReadiness,
  validatePrimitiveCatalog,
  validateSemanticReviewEvidence,
  primitiveSourcesDigest,
  walkFiles,
} from '../validators/primitive-metadata/validate-catalog.mjs';
import { primitiveContentDigest } from '../tools/primitive-content-digest.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('every primitive has catalog, metadata, pinned Architecture, and impact coverage', {
  skip: !process.env.ARCHITECTURE_AUTHORITY_ROOT,
}, async () => {
  assert.deepEqual(await validatePrimitiveCatalog(root), {
    primitives: 15,
    decisions: 23,
    noImpact: 4,
    provisional: 4,
  });
});

function impactFixture() {
  const decisionId = 'ADR-0001';
  const sourceCommit = 'a'.repeat(40);
  const primitive = { id: 'architecture-decision', version: '1.2.3', adrs: [decisionId], decisionIds: [decisionId] };
  return {
    architectureRelease: { version: '0.1.0', sourceCommit, decisionIds: [decisionId] },
    decisionInventory: { records: [{ id: decisionId, origin: { type: 'architecture-baseline' } }] },
    impactReview: {
      architectureVersion: '0.1.0',
      architectureSourceCommit: sourceCommit,
      decisions: [{
        decisionId,
        reviewStatus: 'reviewed',
        disposition: 'affected',
        affectedPrimitives: [{ id: primitive.id, version: primitive.version, scope: 'implementation' }],
        rationale: 'The skill implements the decision-authoring contract.',
      }],
    },
    catalog: { primitives: [primitive] },
  };
}

test('decision-impact coverage accepts a complete primitive mapping', () => {
  assert.deepEqual(validateDecisionImpactCoverage(impactFixture()), {
    decisions: 1,
    affected: 1,
    noImpact: 0,
    provisional: 0,
  });
});

test('decision-impact coverage fails when a newly released decision has no review row', () => {
  const fixture = impactFixture();
  fixture.architectureRelease.decisionIds.push('ADR-0002');
  fixture.decisionInventory.records.push({ id: 'ADR-0002', origin: { type: 'architecture-baseline' } });
  assert.throws(() => validateDecisionImpactCoverage(fixture), /missing impact review for ADR-0002/);
});

test('decision-impact coverage requires each affected primitive version to match the catalog', () => {
  const fixture = impactFixture();
  fixture.impactReview.decisions[0].affectedPrimitives[0].version = '1.2.4';
  assert.throws(() => validateDecisionImpactCoverage(fixture), /does not match catalog version/);
});

test('ADR-only metadata remains an exact compatibility projection of decisionIds', () => {
  const fixture = impactFixture();
  fixture.catalog.primitives[0].adrs.push('ADR-0002');
  assert.throws(() => validateDecisionImpactCoverage(fixture), /ADR-only compatibility projection/);
});

test('decision-impact coverage requires an evidenced no-impact row and no primitive mapping', () => {
  const fixture = impactFixture();
  fixture.impactReview.decisions[0] = {
    decisionId: 'ADR-0001',
    reviewStatus: 'reviewed',
    disposition: 'no-impact',
    affectedPrimitives: [],
    rationale: 'This decision governs a runtime owned by another bounded context.',
  };
  fixture.catalog.primitives[0].decisionIds = [];
  fixture.catalog.primitives[0].adrs = [];
  assert.deepEqual(validateDecisionImpactCoverage(fixture), {
    decisions: 1,
    affected: 0,
    noImpact: 1,
    provisional: 0,
  });
  fixture.impactReview.decisions[0].rationale = '';
  assert.throws(() => validateDecisionImpactCoverage(fixture), /requires a non-empty rationale/);
});

test('proposed Architecture decisions must stay explicitly provisional', () => {
  const fixture = impactFixture();
  fixture.decisionInventory.records[0].origin.type = 'proposed';
  fixture.impactReview.decisions[0].reviewStatus = 'reviewed';
  assert.throws(() => validateDecisionImpactCoverage(fixture), /proposed decision ADR-0001 must be provisional/);
  fixture.impactReview.decisions[0].reviewStatus = 'provisional';
  assert.equal(validateDecisionImpactCoverage(fixture).provisional, 1);
});

test('released Primitives require a released Architecture Authority pin and no provisional decisions', () => {
  const primitiveRelease = { status: 'released' };
  const architectureRelease = { status: 'released' };
  assert.equal(validatePrimitiveReleaseReadiness({
    primitiveRelease,
    architectureRelease,
    provisionalDecisionCount: 0,
  }), true);
  assert.throws(() => validatePrimitiveReleaseReadiness({
    primitiveRelease,
    architectureRelease: { status: 'draft' },
    provisionalDecisionCount: 0,
  }), /must pin a released Architecture Authority release/);
  assert.throws(() => validatePrimitiveReleaseReadiness({
    primitiveRelease,
    architectureRelease,
    provisionalDecisionCount: 1,
  }), /cannot include provisional Architecture decisions/);
  assert.equal(validatePrimitiveReleaseReadiness({
    primitiveRelease: { status: 'draft' },
    architectureRelease: { status: 'draft' },
    provisionalDecisionCount: 4,
  }), true);
});

test('semantic review evidence is bound to the exact catalog, decision set, and Architecture pins', () => {
  const fixture = impactFixture();
  const catalogRaw = '{"catalog":"pinned"}';
  const primitiveSourcesSha256 = primitiveSourcesDigest([
    { path: 'skills/example/SKILL.md', sourceBytes: Buffer.from('# Original\n') },
  ]);
  const architecturePin = {
    releaseManifestCommit: 'b'.repeat(40),
    sourceCommit: 'a'.repeat(40),
    decisionInventorySha256: 'd'.repeat(64),
  };
  const evidence = {
    outcome: 'no-blocking-mapping-findings',
    target: {
      primitiveCatalogSha256: createHash('sha256').update(catalogRaw).digest('hex'),
      primitiveSourcesSha256,
      decisionSetSha256: createHash('sha256').update(JSON.stringify(fixture.impactReview.decisions)).digest('hex'),
      architectureReleaseManifestCommit: architecturePin.releaseManifestCommit,
      architectureSourceCommit: architecturePin.sourceCommit,
      decisionInventorySha256: architecturePin.decisionInventorySha256,
    },
  };
  assert.equal(validateSemanticReviewEvidence({
    evidence,
    impactReview: fixture.impactReview,
    catalogRaw,
    primitiveSourcesSha256,
    architecturePin,
  }), evidence);
  assert.throws(() => validateSemanticReviewEvidence({
    evidence,
    impactReview: fixture.impactReview,
    catalogRaw: `${catalogRaw} changed`,
    primitiveSourcesSha256,
    architecturePin,
  }), /primitiveCatalogSha256 does not match/);
  assert.throws(() => validateSemanticReviewEvidence({
    evidence,
    impactReview: fixture.impactReview,
    catalogRaw,
    primitiveSourcesSha256: 'f'.repeat(64),
    architecturePin,
  }), /primitiveSourcesSha256 does not match/);
  const changedSourcesSha256 = primitiveSourcesDigest([
    { path: 'skills/example/SKILL.md', sourceBytes: Buffer.from('# Changed\n') },
  ]);
  assert.notEqual(primitiveSourcesSha256, changedSourcesSha256);
  assert.throws(() => validateSemanticReviewEvidence({
    evidence,
    impactReview: fixture.impactReview,
    catalogRaw,
    primitiveSourcesSha256: changedSourcesSha256,
    architecturePin,
  }), /primitiveSourcesSha256 does not match/);
  assert.throws(() => validateSemanticReviewEvidence({
    evidence,
    impactReview: fixture.impactReview,
    catalogRaw,
    primitiveSourcesSha256,
    architecturePin: { ...architecturePin, sourceCommit: 'c'.repeat(40) },
  }), /architectureSourceCommit does not match/);
});

test('metadata discovery includes TypeScript source files', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'primitive-metadata-discovery-'));
  try {
    await mkdir(path.join(scratch, 'validators'), { recursive: true });
    await writeFile(path.join(scratch, 'validators', 'example.ts'), '// agentic-primitive: {"id":"example"}\n');
    assert.deepEqual(await walkFiles(scratch, 'validators'), ['validators/example.ts']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('primitive content digest rejects a tree object used as a source commit', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'primitive-content-digest-'));
  const git = (args) => execFileSync('git', ['-C', scratch, ...args], { encoding: 'utf8' }).trim();
  try {
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    await mkdir(path.join(scratch, 'skills', 'example'), { recursive: true });
    await writeFile(path.join(scratch, 'skills', 'example', 'SKILL.md'), '# Example\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'fixture']);
    const tree = git(['rev-parse', 'HEAD^{tree}']);
    await assert.rejects(primitiveContentDigest(scratch, tree), /commit object/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('Architecture manifest and inventory bytes must match their immutable release pins', () => {
  const releaseManifestRaw = JSON.stringify({
    version: '0.1.0',
    sourceCommit: 'a'.repeat(40),
    decisionIds: ['ADR-0001'],
  });
  const decisionInventoryRaw = 'schemaVersion: 1\nrecords:\n  - id: ADR-0001\n';
  const pin = {
    version: '0.1.0',
    sourceCommit: 'a'.repeat(40),
    releaseManifestCommit: 'b'.repeat(40),
    releaseManifestSha256: 'c'.repeat(64),
    decisionInventoryPath: 'architecture/references/decision-inventory.yml',
    decisionInventorySha256: 'd'.repeat(64),
  };
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  pin.releaseManifestSha256 = hash(releaseManifestRaw);
  pin.decisionInventorySha256 = hash(decisionInventoryRaw);
  assert.equal(validateArchitecturePin({ pin, releaseManifestRaw, decisionInventoryRaw }).releaseManifest.version, '0.1.0');
  assert.throws(() => validateArchitecturePin({
    pin: { ...pin, decisionInventorySha256: 'e'.repeat(64) },
    releaseManifestRaw,
    decisionInventoryRaw,
  }), /decision inventory digest does not match/);
});

test('active distribution, metadata, and decision boundaries remain documented', async () => {
  for (const relativePath of [
    'agents/copilot/README.md',
    'validators/primitive-metadata/README.md',
    'docs/decisions/README.md',
    'docs/decisions/ADP-0001-primitive-release-and-projection.md',
  ]) await access(path.join(root, relativePath));
  const adpReference = await readFile(path.join(root, 'docs/decisions/ADP-0001-primitive-release-and-projection.md'), 'utf8');
  assert.match(adpReference, /agentic-delivery-architecture\/blob\/7b1d21462f70c411e75ae67ce80dcf688c9973e8/);
  assert.doesNotMatch(adpReference, /^## Decision Outcome/m);
});

test('extracted skills resolve architecture context through an immutable release pin', async () => {
  const reference = await readFile(path.join(root, 'references/architecture-authority.md'), 'utf8');
  assert.match(reference, /manifests\/primitive-release\.json/);
  assert.match(reference, /exact\s+commit/i);
  for (const file of [
    'skills/ubiquitous-language/SKILL.md',
    'skills/delivery-workflow/SKILL.md',
    'skills/architecture-decision/SKILL.md',
  ]) {
    const source = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /\.\.\/\.\.\/\.\.\/docs\/(?:domain|decisions)/);
    assert.match(source, /Architecture Authority|architecture-authority/);
  }
});

test('draft release pins exact Architecture manifest and source artifacts', async () => {
  const { readFile } = await import('node:fs/promises');
  const release = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../manifests/primitive-release.json'), 'utf8'));
  assert.equal(release.version, '0.1.0-draft.12');
  assert.equal(release.architecture.id, 'urn:agentic-delivery:architecture:authority');
  assert.equal(release.architecture.version, '0.1.0-draft.24');
  assert.equal(release.architecture.releaseManifestCommit, '61d99cbcca175f5bb5de4277d21f2ce4d56cbd0c');
  assert.equal(release.architecture.releaseManifestSha256, '7ffb17661195fcc224b3fdd493e6a68233dcaee4400eae7cc0dd0a97ef4fba69');
  assert.equal(release.architecture.sourceCommit, '7b1d21462f70c411e75ae67ce80dcf688c9973e8');
  assert.equal(release.architecture.decisionInventorySha256, '87f5c8bb2c03ca7208c7ed29f7eeb5ccb8735e17b3d52c7ad126f68dd798a592');
  assert.match(release.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(release.contentSha256, /^[0-9a-f]{64}$/);
});

test('the proposed release contains the current authoritative capability content', async () => {
  const release = JSON.parse(await readFile(path.join(root, 'manifests/primitive-release.json'), 'utf8'));
  assert.equal(
    await primitiveContentDigest(root, release.sourceCommit),
    await primitiveContentDigest(root, 'HEAD'),
    'The proposed release omits authoritative changes from this branch.',
  );
});

test('Primitive content digest is deterministic for a pinned tree', async () => {
  const first = await primitiveContentDigest(root, 'HEAD');
  const second = await primitiveContentDigest(root, 'HEAD');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
});
