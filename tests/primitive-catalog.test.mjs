import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { validatePrimitiveCatalog } from '../tools/validate-primitive-catalog.mjs';
import { primitiveContentDigest } from '../tools/primitive-content-digest.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('every extracted primitive has catalog and metadata coverage', async () => {
  assert.deepEqual(await validatePrimitiveCatalog(root), { primitives: 14 });
});

test('empty primitive extension boundaries remain explicit', async () => {
  for (const relativePath of [
    'agents/copilot/README.md',
    'instructions/README.md',
    'hooks/README.md',
    'scripts/README.md',
    'docs/decisions/README.md',
    'docs/decisions/ADP-0001-primitive-release-and-projection.md',
  ]) await access(path.join(root, relativePath));
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

test('draft release pins the extracted Architecture Authority', async () => {
  const { readFile } = await import('node:fs/promises');
  const release = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../manifests/primitive-release.json'), 'utf8'));
  assert.equal(release.version, '0.1.0-draft.7');
  assert.equal(release.architecture.id, 'urn:agentic-delivery:architecture:authority');
  assert.equal(release.architecture.version, '0.1.0-draft.24');
  assert.equal(release.architecture.sourceCommit, '7b1d21462f70c411e75ae67ce80dcf688c9973e8');
  assert.match(release.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(release.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(await primitiveContentDigest(root, release.sourceCommit), release.contentSha256);
});

test('Primitive content digest is deterministic for a pinned tree', async () => {
  const first = await primitiveContentDigest(root, 'HEAD');
  const second = await primitiveContentDigest(root, 'HEAD');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
});
