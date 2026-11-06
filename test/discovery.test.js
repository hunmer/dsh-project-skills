import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ProjectSkillsProvider,
  apply,
  discoverProjectSkills,
  parseFrontmatter,
} from '../index.js';

const fakeCtx = { logger: { warn() {}, info() {} } };

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-skills-'));
  await mkdir(join(root, '.git'), { recursive: true });
  return root;
}

async function skillFile(root, relative, content) {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return path;
}

test('discovers a directory skill and parses folded frontmatter', async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = await skillFile(
    root,
    '.claude/skills/demo/SKILL.md',
    [
      '---',
      'name: demo',
      'description: >-',
      '  A compact demo skill',
      '  used by the tests.',
      'whenToUse: when testing',
      '---',
      '',
      '# Demo',
      'Secret body text.',
    ].join('\n'),
  );

  const skills = await discoverProjectSkills(root);
  assert.equal(skills.length, 1);
  const [skill] = skills;
  assert.equal(skill.name, 'demo');
  assert.equal(skill.description, 'A compact demo skill used by the tests.');
  assert.equal(skill.whenToUse, 'when testing');
  assert.equal(skill.source, 'project-claude');
  assert.equal(skill.provider, 'project-skills');
  assert.equal(skill.rank, 140);
  assert.equal(skill.path, await realpath(file));
  assert.equal(skill.resourceBase.path, await realpath(join(root, '.claude/skills/demo')));
  assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: true });
});

test('discovers flat skills, quoted values, and the project-root ancestor', async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sub = join(root, 'packages/app');
  await mkdir(sub, { recursive: true });
  await skillFile(
    sub,
    '.agents/skills/local.md',
    '---\nname: "local"\ndescription: \'Local skill\'\n---\nbody\n',
  );
  const parent = await skillFile(
    root,
    '.claude/skills/parent/SKILL.md',
    '---\nname: parent\ndescription: Parent skill\n---\nbody\n',
  );

  const skills = await discoverProjectSkills(sub);
  const names = skills.map((skill) => skill.name).sort();
  assert.deepEqual(names, ['local', 'parent']);
  const local = skills.find((skill) => skill.name === 'local');
  assert.equal(local.rank, 145);
  assert.equal(local.source, 'project-agents');
  const parentSkill = skills.find((skill) => skill.name === 'parent');
  assert.equal(parentSkill.rank, 150);
  assert.equal(parentSkill.path, await realpath(parent));
});

test('higher-priority root wins a duplicate name', async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await skillFile(
    root,
    '.claude/skills/dup/SKILL.md',
    '---\nname: dup\ndescription: from claude\n---\nbody\n',
  );
  await skillFile(
    root,
    '.agents/skills/dup/SKILL.md',
    '---\nname: dup\ndescription: from agents\n---\nbody\n',
  );

  const skills = await discoverProjectSkills(root);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].description, 'from claude');
  assert.equal(skills[0].rank, 140);
});

test('ignores user-disabled, invalid, and description-less skills', async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await skillFile(
    root,
    '.claude/skills/off/SKILL.md',
    '---\nname: off\ndescription: hidden\nuser-invocable: false\n---\nbody\n',
  );
  await skillFile(
    root,
    '.claude/skills/bad/SKILL.md',
    '---\nname: Bad Name\ndescription: invalid\n---\nbody\n',
  );
  await skillFile(root, '.claude/skills/nodesc/SKILL.md', '---\nname: nodesc\n---\nbody\n');
  await skillFile(root, '.claude/skills/ok/SKILL.md', '---\nname: ok\ndescription: fine\n---\nbody\n');

  const skills = await discoverProjectSkills(root);
  assert.deepEqual(skills.map((skill) => skill.name), ['ok']);
});

test('get() returns a pointer instead of the skill body', async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = await skillFile(
    root,
    '.claude/skills/reader/SKILL.md',
    '---\nname: reader\ndescription: Read me\n---\nSECRET BODY\n',
  );

  const provider = new ProjectSkillsProvider(
    fakeCtx,
    { signal: new AbortController().signal },
    {
      providerName: 'project-skills',
      includeClaude: true,
      includeAgents: true,
      extraDirs: [],
    },
  );
  const [candidate] = await provider.list({ cwd: root });
  const definition = await provider.get(candidate, {});

  assert.equal(definition.name, 'reader');
  assert.equal(definition.path, await realpath(file));
  assert.equal(definition.resourceBase.path, await realpath(join(root, '.claude/skills/reader')));
  assert.match(definition.content, new RegExp(escapeRegExp(await realpath(file))));
  assert.match(definition.content, /Read tool/);
  assert.doesNotMatch(definition.content, /SECRET BODY/);
  assert.deepEqual(definition.invocation, { modelInvocable: false, userInvocable: true });
});

test('frontmatter parser handles a literal block and CRLF', () => {
  const parsed = parseFrontmatter(
    ['---', 'name: literal', 'description: |', '  line one', '  line two', '---', 'body'].join('\r\n'),
  );
  assert.equal(parsed.data.name, 'literal');
  assert.equal(parsed.data.description, 'line one\nline two\n');
  assert.equal(parsed.body, 'body');
});

test('apply registers one provider and honors providerName', () => {
  let factory;
  const skills = {
    registerProvider(create) {
      factory = create;
      return () => {};
    },
  };
  const ctx = {
    skills,
    get(name) {
      return name === 'skills' ? skills : undefined;
    },
    agents: { list: () => [] },
    on() {},
    effect(fn) {
      fn();
    },
    logger: fakeCtx.logger,
  };

  apply(ctx, { providerName: 'my-project-skills' });
  assert.equal(typeof factory, 'function');
  const provider = factory({ signal: new AbortController().signal });
  assert.equal(provider.name, 'my-project-skills');
  assert.equal(provider.includeClaude, true);
  assert.equal(provider.includeAgents, true);
});

test('apply also registers inside live agent scopes', () => {
  const made = [];
  const makeSkills = () => ({
    registerProvider(create) {
      made.push(create);
      return () => {};
    },
  });
  const agentSkills = makeSkills();
  const agentCtx = {
    skills: agentSkills,
    get(name) {
      return name === 'skills' ? agentSkills : undefined;
    },
  };
  const globalSkills = makeSkills();
  const ctx = {
    skills: globalSkills,
    get(name) {
      return name === 'skills' ? globalSkills : undefined;
    },
    agents: { list: () => [{ ctx: agentCtx }] },
    on() {},
    effect(fn) {
      fn();
    },
    logger: fakeCtx.logger,
  };

  apply(ctx, {});
  assert.equal(made.length, 2);
});

test('rejects malformed frontmatter', () => {
  assert.equal(parseFrontmatter('# no frontmatter\n'), undefined);
  assert.equal(parseFrontmatter('---\nname: missing-close\n'), undefined);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
