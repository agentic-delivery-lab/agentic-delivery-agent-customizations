// agentic-primitive: {"id":"primitive-catalog-validator","kind":"validator","enforcement":"deterministic","decisionIds":["ADP-0001","ADR-0013","ADR-0018"],"domains":["agentic-primitives"],"adrs":["ADR-0013","ADR-0018"]}

import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

import { primitiveContentDigest } from '../../tools/primitive-content-digest.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARCHITECTURE_MANIFEST_PATH = 'architecture/generated/architecture-release.json';
const EXPECTED_DECISION_INVENTORY_PATH = 'architecture/references/decision-inventory.yml';
const IMPACT_REVIEW_EVIDENCE_PATH = 'manifests/decision-impact-review-evidence.json';
const METADATA_ROOTS = [
  'agents', 'capabilities', 'hooks', 'instructions', 'mcp', 'scripts', 'skills', 'validators',
];
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECISION_ID = /^(ADR|ADP|ADD)-[0-9]{4}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sorted(values) {
  return [...values].sort();
}

function sameValues(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function parseArchitectureInventory(raw) {
  try {
    return parseYaml(raw, { uniqueKeys: true, prettyErrors: true });
  } catch (error) {
    throw new Error(`Architecture decision inventory is not valid YAML: ${error.message}`);
  }
}

function validateUniqueIdentifiers(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !DECISION_ID.test(value)) throw new Error(`${label} contains an invalid decision id`);
    if (seen.has(value)) throw new Error(`${label} contains duplicate decision id ${value}`);
    seen.add(value);
  }
  return seen;
}

export function validateArchitecturePin({ pin, releaseManifestRaw, decisionInventoryRaw }) {
  if (!COMMIT.test(pin.releaseManifestCommit ?? '')) throw new Error('Architecture releaseManifestCommit must be an immutable commit SHA');
  if (!COMMIT.test(pin.sourceCommit ?? '')) throw new Error('Architecture sourceCommit must be an immutable commit SHA');
  if (!SHA256.test(pin.releaseManifestSha256 ?? '') || sha256(releaseManifestRaw) !== pin.releaseManifestSha256) {
    throw new Error('Architecture release manifest digest does not match the pinned SHA-256');
  }
  if (pin.decisionInventoryPath !== EXPECTED_DECISION_INVENTORY_PATH) {
    throw new Error(`Architecture decisionInventoryPath must be ${EXPECTED_DECISION_INVENTORY_PATH}`);
  }
  if (!SHA256.test(pin.decisionInventorySha256 ?? '') || sha256(decisionInventoryRaw) !== pin.decisionInventorySha256) {
    throw new Error('Architecture decision inventory digest does not match the pinned SHA-256');
  }

  const releaseManifest = parseJson(Buffer.isBuffer(releaseManifestRaw) ? releaseManifestRaw.toString('utf8') : releaseManifestRaw, 'Architecture release manifest');
  if (releaseManifest.version !== pin.version) throw new Error('Architecture release version does not match the pinned version');
  if (releaseManifest.sourceCommit !== pin.sourceCommit) throw new Error('Architecture source commit does not match the release manifest');
  if (!Array.isArray(releaseManifest.decisionIds)) throw new Error('Architecture release manifest must list decisionIds');

  const decisionInventory = parseArchitectureInventory(Buffer.isBuffer(decisionInventoryRaw) ? decisionInventoryRaw.toString('utf8') : decisionInventoryRaw);
  if (decisionInventory?.schemaVersion !== 1 || !Array.isArray(decisionInventory.records)) {
    throw new Error('Architecture decision inventory must use schemaVersion 1 and contain records');
  }
  const releaseIds = validateUniqueIdentifiers(releaseManifest.decisionIds, 'Architecture release manifest');
  const inventoryIds = validateUniqueIdentifiers(decisionInventory.records.map((record) => record?.id), 'Architecture decision inventory');
  if (!sameValues(releaseIds, inventoryIds)) throw new Error('Architecture release decisionIds do not match the pinned source inventory');

  return {
    releaseManifest,
    decisionInventory,
    decisionInventorySha256: pin.decisionInventorySha256,
  };
}

export function validateDecisionImpactCoverage({ architectureRelease, decisionInventory, impactReview, catalog }) {
  const releaseIds = validateUniqueIdentifiers(architectureRelease?.decisionIds ?? [], 'Architecture release manifest');
  const inventoryRecords = decisionInventory?.records;
  if (!Array.isArray(inventoryRecords)) throw new Error('Architecture decision inventory must contain records');
  const inventoryIds = validateUniqueIdentifiers(inventoryRecords.map((record) => record?.id), 'Architecture decision inventory');
  if (!sameValues(releaseIds, inventoryIds)) throw new Error('Architecture release decisionIds do not match the pinned source inventory');

  if (impactReview.architectureVersion !== architectureRelease.version) {
    throw new Error('impact review Architecture version does not match the pinned release');
  }
  if (impactReview.architectureSourceCommit !== architectureRelease.sourceCommit) {
    throw new Error('impact review Architecture source commit does not match the pinned release');
  }
  if (architectureRelease.decisionInventorySha256
    && impactReview.decisionInventorySha256 !== architectureRelease.decisionInventorySha256) {
    throw new Error('impact review decision inventory digest does not match the pinned release');
  }

  const rows = impactReview.decisions;
  if (!Array.isArray(rows)) throw new Error('impact review must contain decisions');
  const rowIds = rows.map((row) => row?.decisionId);
  const reviewIds = validateUniqueIdentifiers(rowIds, 'impact review');
  for (const decisionId of releaseIds) {
    if (!reviewIds.has(decisionId)) throw new Error(`missing impact review for ${decisionId}`);
  }
  for (const decisionId of reviewIds) {
    if (!releaseIds.has(decisionId)) throw new Error(`impact review contains decision outside the pinned release: ${decisionId}`);
  }

  const recordsById = new Map(inventoryRecords.map((record) => [record.id, record]));
  const primitivesById = new Map();
  for (const primitive of catalog.primitives) {
    if (primitivesById.has(primitive.id)) throw new Error(`catalog primitive id is duplicated: ${primitive.id}`);
    primitivesById.set(primitive.id, primitive);
  }
  const expectedDecisionIds = new Map([...primitivesById.keys()].map((id) => [id, new Set()]));
  let affected = 0;
  let noImpact = 0;
  let provisional = 0;

  for (const row of rows) {
    const record = recordsById.get(row.decisionId);
    if (!record?.origin || typeof record.origin.type !== 'string' || record.origin.type.length === 0) {
      throw new Error(`Architecture decision ${row.decisionId} is missing origin.type`);
    }
    const expectedReviewStatus = record.origin?.type === 'proposed' ? 'provisional' : 'reviewed';
    if (row.reviewStatus !== expectedReviewStatus) {
      const qualifier = expectedReviewStatus === 'provisional' ? 'must be provisional' : 'cannot be provisional';
      throw new Error(`${expectedReviewStatus === 'provisional' ? 'proposed' : 'non-proposed'} decision ${row.decisionId} ${qualifier}`);
    }
    if (expectedReviewStatus === 'provisional') provisional += 1;
    if (typeof row.rationale !== 'string' || row.rationale.trim().length < 20) {
      throw new Error(`impact review for ${row.decisionId} requires a non-empty rationale of at least 20 characters`);
    }

    if (row.disposition === 'no-impact') {
      if (row.affectedPrimitives.length !== 0) throw new Error(`no-impact decision ${row.decisionId} cannot list affected primitives`);
      noImpact += 1;
      continue;
    }
    if (row.disposition !== 'affected' || row.affectedPrimitives.length === 0) {
      throw new Error(`affected decision ${row.decisionId} must list at least one primitive`);
    }

    const affectedIds = new Set();
    for (const mapping of row.affectedPrimitives) {
      if (affectedIds.has(mapping.id)) throw new Error(`impact review for ${row.decisionId} duplicates primitive ${mapping.id}`);
      affectedIds.add(mapping.id);
      const primitive = primitivesById.get(mapping.id);
      if (!primitive) throw new Error(`impact review for ${row.decisionId} references uncataloged primitive ${mapping.id}`);
      if (primitive.version !== mapping.version) {
        throw new Error(`impact review for ${row.decisionId} primitive ${mapping.id} version ${mapping.version} does not match catalog version ${primitive.version}`);
      }
      expectedDecisionIds.get(mapping.id).add(row.decisionId);
    }
    affected += 1;
  }

  for (const [primitiveId, expected] of expectedDecisionIds) {
    const primitive = primitivesById.get(primitiveId);
    if (!sameValues(primitive.decisionIds, expected)) {
      throw new Error(`catalog decisionIds for ${primitiveId} do not match its impact-review mappings`);
    }
    const expectedAdrs = primitive.decisionIds.filter((decisionId) => decisionId.startsWith('ADR-'));
    if (!sameValues(primitive.adrs, expectedAdrs)) {
      throw new Error(`catalog adrs for ${primitiveId} must preserve its ADR-only compatibility projection`);
    }
  }
  return { decisions: rows.length, affected, noImpact, provisional };
}

export function validateSemanticReviewEvidence({
  evidence,
  impactReview,
  catalogRaw,
  primitiveSourcesSha256,
  architecturePin,
}) {
  const target = evidence?.target;
  const expected = {
    primitiveCatalogSha256: sha256(catalogRaw),
    primitiveSourcesSha256,
    decisionSetSha256: sha256(JSON.stringify(impactReview.decisions)),
    architectureReleaseManifestCommit: architecturePin.releaseManifestCommit,
    architectureSourceCommit: architecturePin.sourceCommit,
    decisionInventorySha256: architecturePin.decisionInventorySha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (target?.[key] !== value) throw new Error(`semantic review evidence ${key} does not match the reviewed artifacts`);
  }
  if (evidence.outcome !== 'no-blocking-mapping-findings') {
    throw new Error('semantic review evidence must have no blocking mapping findings');
  }
  return evidence;
}

export function primitiveSourcesDigest(sources) {
  const sourceHash = createHash('sha256');
  const orderedSources = [...sources].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const { path: relativePath, sourceBytes } of orderedSources) {
    sourceHash.update(relativePath, 'utf8');
    sourceHash.update('\0', 'utf8');
    sourceHash.update(sourceBytes);
    sourceHash.update('\0', 'utf8');
  }
  return sourceHash.digest('hex');
}

export function validatePrimitiveReleaseReadiness({ primitiveRelease, architectureRelease, provisionalDecisionCount }) {
  if (primitiveRelease.status !== 'released') return true;
  if (architectureRelease.status !== 'released') {
    throw new Error('a released Primitive must pin a released Architecture Authority release');
  }
  if (provisionalDecisionCount !== 0) {
    throw new Error('a released Primitive cannot include provisional Architecture decisions');
  }
  return true;
}

async function gitShow(repositoryRoot, revision, filePath) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'show', `${revision}:${filePath}`], {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function loadPinnedArchitectureAuthority(architectureRoot, pin) {
  if (!architectureRoot) throw new Error('ARCHITECTURE_AUTHORITY_ROOT must point to the pinned Architecture Authority checkout');
  const releaseManifestRaw = await gitShow(architectureRoot, pin.releaseManifestCommit, ARCHITECTURE_MANIFEST_PATH);
  const decisionInventoryRaw = await gitShow(architectureRoot, pin.sourceCommit, pin.decisionInventoryPath);
  return validateArchitecturePin({ pin, releaseManifestRaw, decisionInventoryRaw });
}

export async function walkFiles(repositoryRoot, relativeDirectory) {
  const absoluteDirectory = path.join(repositoryRoot, relativeDirectory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(repositoryRoot, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function extractMetadata(source, relativePath) {
  const matches = [
    ...source.matchAll(/<!--\s*agentic-primitive:\s*(\{[^\r\n]*\})\s*-->/g),
    ...source.matchAll(/^\s*\/\/\s*agentic-primitive:\s*(\{[^\r\n]*\})\s*$/gm),
  ];
  if (matches.length > 1) throw new Error(`${relativePath} has multiple agentic-primitive metadata blocks`);
  if (matches.length === 0) return null;
  try {
    return JSON.parse(matches[0][1]);
  } catch (error) {
    throw new Error(`${relativePath} metadata is not valid JSON: ${error.message}`);
  }
}

async function readSchema(repositoryRoot, relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
}

async function makeValidators(repositoryRoot) {
  const [catalogSchema, primitiveSchema, metadataSchema, impactSchema, evidenceSchema, releaseSchema] = await Promise.all([
    readSchema(repositoryRoot, 'schemas/primitive-catalog.schema.json'),
    readSchema(repositoryRoot, 'schemas/primitive.schema.json'),
    readSchema(repositoryRoot, 'schemas/primitive-metadata.schema.json'),
    readSchema(repositoryRoot, 'schemas/primitive-impact-review.schema.json'),
    readSchema(repositoryRoot, 'schemas/primitive-impact-review-evidence.schema.json'),
    readSchema(repositoryRoot, 'schemas/primitive-release.schema.json'),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(primitiveSchema);
  return {
    ajv,
    catalog: ajv.compile(catalogSchema),
    metadata: ajv.compile(metadataSchema),
    impact: ajv.compile(impactSchema),
    evidence: ajv.compile(evidenceSchema),
    release: ajv.compile(releaseSchema),
  };
}

function compareMetadata(metadata, primitive, relativePath) {
  for (const key of ['id', 'kind', 'enforcement']) {
    if (metadata[key] !== primitive[key]) throw new Error(`${relativePath} metadata ${key} does not match catalog primitive ${primitive.id}`);
  }
  for (const key of ['adrs', 'decisionIds', 'domains']) {
    if (!sameValues(metadata[key], primitive[key])) throw new Error(`${relativePath} metadata ${key} does not match catalog primitive ${primitive.id}`);
  }
}

export async function validatePrimitiveCatalog(repositoryRoot = root, { architectureRoot = process.env.ARCHITECTURE_AUTHORITY_ROOT } = {}) {
  const errors = [];
  let validators;
  try {
    validators = await makeValidators(repositoryRoot);
  } catch (error) {
    throw new Error(`primitive schemas cannot be loaded: ${error.message}`);
  }

  let catalog;
  let catalogRaw;
  try {
    catalogRaw = await readFile(path.join(repositoryRoot, 'manifests/primitive-catalog.yml'), 'utf8');
    catalog = parseYaml(catalogRaw, {
      uniqueKeys: true,
      prettyErrors: true,
    });
    if (!validators.catalog(catalog)) errors.push(`primitive catalog schema validation failed: ${validators.ajv.errorsText(validators.catalog.errors)}`);
  } catch (error) {
    errors.push(`manifests/primitive-catalog.yml cannot be parsed: ${error.message}`);
  }

  let release;
  try {
    release = parseJson(await readFile(path.join(repositoryRoot, 'manifests/primitive-release.json'), 'utf8'), 'manifests/primitive-release.json');
    if (!validators.release(release)) errors.push(`primitive release schema validation failed: ${validators.ajv.errorsText(validators.release.errors)}`);
    if (release.releaseId !== `urn:agentic-delivery:primitive-release:${release.version}`) {
      errors.push('primitive release releaseId must include its exact version');
    }
  } catch (error) {
    errors.push(error.message);
  }

  let impactReview;
  try {
    impactReview = parseJson(await readFile(path.join(repositoryRoot, 'manifests/decision-impact-review.json'), 'utf8'), 'manifests/decision-impact-review.json');
    if (!validators.impact(impactReview)) errors.push(`decision impact review schema validation failed: ${validators.ajv.errorsText(validators.impact.errors)}`);
  } catch (error) {
    errors.push(error.message);
  }

  let semanticReviewEvidence;
  if (impactReview) {
    try {
      const pointer = impactReview.semanticReview;
      if (pointer?.evidencePath !== IMPACT_REVIEW_EVIDENCE_PATH) {
        throw new Error(`semantic review evidence path must be ${IMPACT_REVIEW_EVIDENCE_PATH}`);
      }
      const evidenceRaw = await readFile(path.join(repositoryRoot, pointer.evidencePath), 'utf8');
      if (!SHA256.test(pointer.evidenceSha256 ?? '') || sha256(evidenceRaw) !== pointer.evidenceSha256) {
        throw new Error('semantic review evidence digest does not match its pinned SHA-256');
      }
      semanticReviewEvidence = parseJson(evidenceRaw, IMPACT_REVIEW_EVIDENCE_PATH);
      if (!validators.evidence(semanticReviewEvidence)) {
        throw new Error(`semantic review evidence schema validation failed: ${validators.ajv.errorsText(validators.evidence.errors)}`);
      }
    } catch (error) {
      errors.push(`semantic review evidence validation failed: ${error.message}`);
    }
  }

  let primitiveSourcesSha256;
  if (catalog?.primitives) {
    const primitiveIds = new Set();
    const primitivePaths = new Set();
    const catalogByPath = new Map();
    const primitiveSources = [];
    for (const primitive of catalog.primitives) {
      if (primitiveIds.has(primitive.id)) errors.push(`catalog primitive id is duplicated: ${primitive.id}`);
      primitiveIds.add(primitive.id);
      if (primitivePaths.has(primitive.path)) errors.push(`catalog primitive path is duplicated: ${primitive.path}`);
      primitivePaths.add(primitive.path);
      catalogByPath.set(primitive.path, primitive);
      if (primitive.path.split('/').some((segment) => segment === '.' || segment === '..')
        || path.posix.normalize(primitive.path) !== primitive.path) {
        errors.push(`primitive path must be normalized and repository-relative: ${primitive.path}`);
        continue;
      }
      const absolutePath = path.resolve(repositoryRoot, primitive.path);
      if (!absolutePath.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`)) {
        errors.push(`primitive path escapes repository root: ${primitive.path}`);
        continue;
      }
      try {
        const sourceBytes = await readFile(absolutePath);
        primitiveSources.push({ path: primitive.path, sourceBytes });
        const metadata = extractMetadata(sourceBytes.toString('utf8'), primitive.path);
        if (!metadata) {
          errors.push(`${primitive.path} is missing agentic-primitive metadata`);
          continue;
        }
        if (!validators.metadata(metadata)) {
          errors.push(`${primitive.path} metadata schema validation failed: ${validators.ajv.errorsText(validators.metadata.errors)}`);
          continue;
        }
        compareMetadata(metadata, primitive, primitive.path);
      } catch (error) {
        errors.push(`${primitive.path} cannot be validated: ${error.message}`);
      }
    }

    if (primitiveSources.length === catalog.primitives.length) {
      primitiveSourcesSha256 = primitiveSourcesDigest(primitiveSources);
    }

    for (const relativeRoot of METADATA_ROOTS) {
      for (const relativePath of await walkFiles(repositoryRoot, relativeRoot)) {
        try {
          const sourceBytes = await readFile(path.join(repositoryRoot, relativePath));
          if (sourceBytes.includes(0)) continue;
          const metadata = extractMetadata(sourceBytes.toString('utf8'), relativePath);
          if (!metadata) continue;
          if (!catalogByPath.has(relativePath)) errors.push(`${relativePath} has primitive metadata but is absent from the catalog`);
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
  }

  if (semanticReviewEvidence) {
    try {
      if (!primitiveSourcesSha256) throw new Error('cataloged primitive source digest cannot be calculated');
      validateSemanticReviewEvidence({
        evidence: semanticReviewEvidence,
        impactReview,
        catalogRaw,
        primitiveSourcesSha256,
        architecturePin: release?.architecture,
      });
    } catch (error) {
      errors.push(`semantic review evidence validation failed: ${error.message}`);
    }
  }

  let architectureAuthority;
  if (release?.architecture) {
    try {
      architectureAuthority = await loadPinnedArchitectureAuthority(architectureRoot, release.architecture);
    } catch (error) {
      errors.push(`Architecture Authority pin validation failed: ${error.message}`);
    }
  }

  let impactResult;
  if (catalog?.primitives && release?.architecture && impactReview && architectureAuthority) {
    try {
      impactResult = validateDecisionImpactCoverage({
        architectureRelease: {
          ...architectureAuthority.releaseManifest,
          decisionInventorySha256: architectureAuthority.decisionInventorySha256,
        },
        decisionInventory: architectureAuthority.decisionInventory,
        impactReview,
        catalog,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (release?.status === 'released' && architectureAuthority && impactResult) {
    try {
      validatePrimitiveReleaseReadiness({
        primitiveRelease: release,
        architectureRelease: architectureAuthority.releaseManifest,
        provisionalDecisionCount: impactResult.provisional,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (release?.sourceCommit && release?.contentSha256) {
    try {
      const digest = await primitiveContentDigest(repositoryRoot, release.sourceCommit);
      if (digest !== release.contentSha256) errors.push('primitive release contentSha256 does not match its pinned sourceCommit');
    } catch (error) {
      errors.push(`primitive release sourceCommit cannot be verified: ${error.message}`);
    }
  }

  if (errors.length > 0) throw new Error(`primitive catalog check failed:\n${errors.join('\n')}`);
  return {
    primitives: catalog.primitives.length,
    decisions: impactResult.decisions,
    noImpact: impactResult.noImpact,
    provisional: impactResult.provisional,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await validatePrimitiveCatalog(process.argv[2] ?? root);
    process.stdout.write(`primitive catalog check passed: ${result.primitives} primitives, ${result.decisions} Architecture decisions (${result.noImpact} no-impact, ${result.provisional} provisional).\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
