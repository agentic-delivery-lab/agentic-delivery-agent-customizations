import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { validateNativeSkillSource, validatePrimitiveCatalog } from '../validators/primitive-metadata/validate-catalog.mjs';

const root = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);
const baseline = '96d0852cdd3e95c7a7982a97b95d035fd77a323e';
const catalog = parseYaml(await readFile(path.join(root, 'manifests/primitive-catalog.yml'), 'utf8'));
const skills = catalog.primitives.filter(primitive => primitive.kind === 'skill');

test('native skill validation rejects missing, ambiguous and mismatched discovery fields', () => {
  const primitive = { id: 'example-skill', path: 'skills/example-skill/SKILL.md' };
  const valid = '---\nname: example-skill\ndescription: A useful skill.\n---\n\n# Instructions\n';
  assert.doesNotThrow(() => validateNativeSkillSource(valid, primitive));
  assert.doesNotThrow(() => validateNativeSkillSource(valid.replaceAll('\n', '\r\n'), primitive));
  for (const invalid of [
    `<!-- metadata -->\n${valid}`,
    valid.replace('name: example-skill', 'name: different-skill'),
    valid.replace('name: example-skill', 'name: example-skill\nname: duplicate'),
    valid.replace('description: A useful skill.', 'description: 42'),
    valid.replace('description: A useful skill.', 'description: " "'),
    valid.replace('description: A useful skill.', ''),
  ]) assert.throws(() => validateNativeSkillSource(invalid, primitive));
});

test('catalog rejects the published leading-comment layout omitted by native skill discovery', {
  skip: !process.env.ARCHITECTURE_AUTHORITY_ROOT,
}, async (t) => {
  const parent = path.join(`${root}.worktrees`, 'owned-clones');
  await mkdir(parent, { recursive: true });
  const fixture = await mkdtemp(path.join(parent, 'native-skill-format-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await run('git', ['clone', '--quiet', '--shared', '--no-checkout', root, fixture]);
  await run('git', ['-C', fixture, 'checkout', '--quiet', '--detach', baseline]);
  await assert.rejects(validatePrimitiveCatalog(fixture), (error) => {
    for (const skill of skills) {
      assert.ok(error.message.includes(`${skill.path} must start with YAML frontmatter`), error.message);
    }
    return true;
  });
});

test('canonical skill correction preserves exact YAML, metadata and instruction bytes', async () => {
  assert.equal(skills.length, 4);
  for (const skill of skills) {
    const { stdout: old } = await run('git', ['-C', root, 'show', `${baseline}:${skill.path}`]);
    const original = /^(<!--[\s\S]*?-->\n\n)---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(old);
    assert.ok(original);
    const [, prefix, oldHeader, oldBody] = original;
    const current = await readFile(path.join(root, skill.path), 'utf8');
    assert.equal(current, `---\n${oldHeader}\n---\n\n${prefix.trim()}\n${oldBody}`,
      `${skill.path} must contain only the metadata relocation`);
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(current);
    assert.ok(header, `${skill.path} must start with YAML frontmatter`);
    assert.deepEqual(parseYaml(header[1]), parseYaml(oldHeader));
    assert.equal(parseYaml(header[1]).name, skill.id);
    const metadata = [...current.matchAll(/<!--\s*agentic-primitive:\s*(\{[^\r\n]*\})\s*-->/g)];
    assert.equal(metadata.length, 1);
    assert.ok(metadata[0].index >= header[0].length);
    assert.equal(metadata[0][0], prefix.trim());
    assert.ok(current.endsWith(oldBody), `${skill.path} instruction body changed`);
  }
});
