import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { validateArchitecturePin, validateDecisionImpactCoverage, validateSemanticReviewEvidence } from '../validators/primitive-metadata/validate-catalog.mjs';

const root = path.resolve(import.meta.dirname, '..');
const architectureRoot = process.env.ADOPTED_ARCHITECTURE_TEST_ROOT
  ?? process.env.ARCHITECTURE_AUTHORITY_ROOT
  ?? path.resolve(root, '../agentic-delivery-architecture');
const commit = 'ba804c044bd7dc0a7c5568062d43a1f0d9f3141b';
const adoptedIds = ['ADR-0020', 'ADR-0021', 'ADR-0022', 'ADR-0023', 'ADR-0024'];
const pin = { id: 'urn:agentic-delivery:architecture:authority', version: '0.1.0', releaseManifestCommit: commit,
  releaseManifestSha256: '60fcde50625347826597acd55aae8cfef259a05ca793a7f36380fdc74a4e1acb',
  sourceCommit: '0423533176ad6239fe5d828736605b5a6360293c', decisionInventoryPath: 'architecture/references/decision-inventory.yml',
  decisionInventorySha256: 'cd5df6c97365dd469c35fb47351d70e1a0bbd5bbc3adb99e09ec930660b825cb' };
function inputs() {
  const source = file => execFileSync('git', ['--no-replace-objects', '--no-lazy-fetch', '-C', architectureRoot, 'show', `${commit}:${file}`], { maxBuffer: 1024 * 1024 });
  return { pin, releaseManifestRaw: source('architecture/generated/architecture-release.json'),
    decisionInventoryRaw: source(pin.decisionInventoryPath),
    ownerAcceptanceRaw: source('architecture/references/owner-scope-acceptance-2026-11-03.md') };
}
async function coveredFixture() {
  const authority = validateArchitecturePin(inputs());
  const impactReview = JSON.parse(await readFile(path.join(root, 'manifests/decision-impact-review.json'), 'utf8'));
  impactReview.architectureVersion = authority.releaseManifest.version;
  impactReview.architectureSourceCommit = authority.releaseManifest.sourceCommit;
  impactReview.decisionInventorySha256 = authority.decisionInventorySha256;
  for (const row of impactReview.decisions) if (adoptedIds.includes(row.decisionId)) row.reviewStatus = 'reviewed';
  const catalog = parseYaml(await readFile(path.join(root, 'manifests/primitive-catalog.yml'), 'utf8'));
  return { architectureRelease: { ...authority.releaseManifest, decisionInventorySha256: authority.decisionInventorySha256 },
    decisionInventory: authority.decisionInventory, impactReview, catalog, verifiedOwnerAdoption: authority.ownerAdoption };
}

test('exact owner-adopted source can review historical proposed origins without rewriting them', async () => {
  const fixture = await coveredFixture();
  assert.equal(fixture.verifiedOwnerAdoption?.sha256, '8bea8ea1d02e081baa60b3e35ba0d4a662d1491e3512cc1f07e0dc578f7214e1');
  assert.equal(validateDecisionImpactCoverage(fixture).provisional, 0);
  assert.deepEqual(fixture.decisionInventory.records.filter(r => r.origin.type === 'proposed').map(r => r.id), adoptedIds);
  delete fixture.verifiedOwnerAdoption;
  assert.throws(() => validateDecisionImpactCoverage(fixture), /must be provisional/);
});

test('missing, modified or status-only owner adoption inputs cannot grant reviewed status', () => {
  const original = inputs();
  for (const ownerAcceptanceRaw of [undefined, Buffer.concat([original.ownerAcceptanceRaw, Buffer.from('\nchanged')])]) {
    assert.throws(() => validateArchitecturePin({ ...original, ownerAcceptanceRaw }), /owner adoption/i);
  }
  const manifest = JSON.parse(original.releaseManifestRaw); manifest.status = 'draft';
  const releaseManifestRaw = Buffer.from(JSON.stringify(manifest));
  assert.throws(() => validateArchitecturePin({ ...original, releaseManifestRaw,
    pin: { ...pin, releaseManifestSha256: createHash('sha256').update(releaseManifestRaw).digest('hex') } }), /owner adoption/i);
});

test('unknown or partial adoption references and extra proposed decisions stay fail-closed', async () => {
  const fixture = await coveredFixture();
  for (const proof of [{}, { ...fixture.verifiedOwnerAdoption, sha256: '0'.repeat(64) }, { ...fixture.verifiedOwnerAdoption, approval: true }]) {
    assert.throws(() => validateDecisionImpactCoverage({ ...fixture, verifiedOwnerAdoption: proof }), /owner adoption/i);
  }
  fixture.architectureRelease.decisionIds.push('ADR-0025');
  fixture.decisionInventory.records.push({ id: 'ADR-0025', origin: { type: 'proposed' } });
  fixture.impactReview.decisions.push({ decisionId: 'ADR-0025', reviewStatus: 'reviewed', disposition: 'no-impact', affectedPrimitives: [], rationale: 'Synthetic unadopted proposal must not receive automatic review.' });
  assert.throws(() => validateDecisionImpactCoverage(fixture), /proposed decision ADR-0025 must be provisional/);
});

test('old independent review cannot be retargeted by owner adoption or matching catalog bytes', async () => {
  const fixture = await coveredFixture();
  const evidence = JSON.parse(execFileSync('git', ['--no-replace-objects', '--no-lazy-fetch', '-C', root, 'show', '69beab027d8b28fc082fa6054f4def5ba0146e3c:manifests/decision-impact-review-evidence.json'], { encoding: 'utf8' }));
  const catalogRaw = await readFile(path.join(root, 'manifests/primitive-catalog.yml'), 'utf8');
  assert.throws(() => validateSemanticReviewEvidence({ evidence, impactReview: fixture.impactReview,
    catalogRaw,
    primitiveSourcesSha256: evidence.target.primitiveSourcesSha256, architecturePin: pin }), /does not match/);
});
