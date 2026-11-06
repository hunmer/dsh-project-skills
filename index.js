/**
 * Project skills provider for DeepSeek Harness.
 *
 * Discovers skills stored in the workspace's `.claude/skills` and/or
 * `.agents/skills` directories and publishes them through `ctx.skills`.
 *
 * The skills are deliberately published as user-invocable only
 * (`modelInvocable: false`):
 *
 * - the model does not see them in the `skill` tool catalog;
 * - selecting `/name` in the composer injects a short instruction that points
 *   at the absolute `SKILL.md` path instead of the skill body;
 * - the agent then reads that file with its normal file-reading tool and
 *   follows it.
 *
 * That keeps the full skill text out of the prompt and out of the skill tool,
 * while still giving the composer a first-class `/` entry.
 *
 * Supported layouts (same as the DSH filesystem provider):
 *
 *   <root>/<skill-name>/SKILL.md
 *   <root>/<skill-name>.md
 *
 * Root precedence (lower rank wins a duplicate name):
 *
 *   <cwd>/.claude/skills                 140
 *   <cwd>/.agents/skills                 145
 *   <project-root>/.claude/skills        150   (project root = nearest .git)
 *   <project-root>/.agents/skills        155
 *   <extraDirs>                          160
 *
 * @module dsh-project-skills
 */

import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const name = 'project-skills';
export const inject = ['skills', 'agents'];

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RANKS = {
  cwdClaude: 140,
  cwdAgents: 145,
  rootClaude: 150,
  rootAgents: 155,
  extra: 160,
};

/**
 * Register the project-skills provider on the skill registry.
 *
 * A registration is scoped to the Cordis context that makes it. The host
 * context lands in the registry's global layer, but an agent preset mounts its
 * own `skill-filesystem` provider in a nearer scope, and a nearer layer wins a
 * duplicate skill name outright — rank only decides duplicates inside one
 * layer. To let project `.claude`/`.agents` skills replace that built-in
 * entry, register once per live agent as well, in the agent's own scope.
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config);
  const registered = new WeakSet();
  const disposers = new Set();

  const registerFor = (scopeCtx) => {
    if (registered.has(scopeCtx)) return;
    // `ctx.get` reads an optional service without requiring this plugin's
    // injection declaration to be repeated on the borrowed agent context.
    const skills = scopeCtx.get('skills');
    if (skills === undefined) return;
    registered.add(scopeCtx);
    let dispose;
    try {
      dispose = skills.registerProvider((control) => {
        return new ProjectSkillsProvider(scopeCtx, control, settings);
      });
    } catch (error) {
      // A hot reload can race the previous fiber's agent-scope registration:
      // the old provider is still alive while the new fiber applies. Keep the
      // existing provider instead of failing the whole plugin.
      if (isDuplicateProviderError(error)) {
        ctx.logger?.warn?.(
          `project-skills: keeping the already registered provider in this scope`,
        );
        return;
      }
      throw error;
    }
    // The host-layer registration is already owned by this plugin's fiber.
    // Agent-scope registrations need explicit teardown on plugin unload.
    if (scopeCtx !== ctx) disposers.add(dispose);
  };

  // Host layer: useful for consumers that list skills without an agent scope.
  registerFor(ctx);

  // Agent layer: wins duplicate names over the preset's own skill-filesystem.
  for (const agent of ctx.agents.list()) {
    registerFor(agent.ctx);
  }
  ctx.on('agent/created', (event) => {
    const agent = event?.agent ?? event;
    if (agent?.ctx !== undefined) registerFor(agent.ctx);
  });

  // Agent-scope registrations are owned by the agent's fiber, so dispose them
  // explicitly when this plugin unloads or is disabled.
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
    disposers.clear();
  });
}

/** A skill provider that maps project skill files into user-only `/` entries. */
export class ProjectSkillsProvider {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ signal: AbortSignal }} control
   * @param {ReturnType<typeof normalizeConfig>} config
   */
  constructor(ctx, control, config = normalizeConfig({})) {
    this.ctx = ctx;
    this.name = config.providerName;
    this.includeClaude = config.includeClaude;
    this.includeAgents = config.includeAgents;
    this.extraDirs = config.extraDirs;
    this.signal = control.signal;
  }

  /**
   * Discover project skills for one workspace.
   * @param {{ cwd?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>}
   */
  async list(options = {}) {
    const signal = options.signal ?? this.signal;
    throwIfAborted(signal);
    if (typeof options.cwd !== 'string' || options.cwd.length === 0) return [];

    const roots = await resolveRoots(resolve(options.cwd), this);
    const byName = new Map();
    for (const root of roots) {
      throwIfAborted(signal);
      for (const skill of await scanRoot(root, this.ctx, signal, this.name)) {
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      }
    }
    return [...byName.values()];
  }

  /**
   * Load one candidate as a pointer definition. The body is intentionally not
   * returned: the agent must read the file named in `content`.
   * @param {object} candidate
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object | undefined>}
   */
  async get(candidate, options = {}) {
    const signal = options.signal ?? this.signal;
    throwIfAborted(signal);
    const locator = candidate?.locator;
    if (locator === undefined || typeof locator.path !== 'string') return undefined;

    const parsed = await readSkillFile(locator.path, undefined, this.ctx, signal, {
      quiet: true,
    });
    if (parsed === undefined || parsed.name !== candidate.name) return undefined;

    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: { modelInvocable: false, userInvocable: true },
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: parsed.directory },
      path: parsed.path,
      content: renderReadInstruction(parsed),
    };
  }
}

/**
 * Standalone discovery used by tests and by code that wants the candidate list
 * without a live registry.
 * @param {string} cwd
 * @param {object} [config]
 * @returns {Promise<object[]>}
 */
export async function discoverProjectSkills(cwd, config = {}) {
  const settings = normalizeConfig(config);
  const provider = new ProjectSkillsProvider(
    { logger: { warn() {}, info() {} } },
    { signal: new AbortController().signal },
    settings,
  );
  return provider.list({ cwd });
}

function normalizeConfig(config = {}) {
  return {
    providerName:
      typeof config.providerName === 'string' && config.providerName.length > 0
        ? config.providerName
        : 'project-skills',
    includeClaude: config.includeClaude !== false,
    includeAgents: config.includeAgents !== false,
    extraDirs: Array.isArray(config.extraDirs)
      ? config.extraDirs.filter((dir) => typeof dir === 'string' && dir.length > 0)
      : [],
  };
}

async function resolveRoots(cwd, provider) {
  const roots = [];
  if (provider.includeClaude) {
    roots.push({
      path: join(cwd, '.claude', 'skills'),
      source: 'project-claude',
      rank: RANKS.cwdClaude,
    });
  }
  if (provider.includeAgents) {
    roots.push({
      path: join(cwd, '.agents', 'skills'),
      source: 'project-agents',
      rank: RANKS.cwdAgents,
    });
  }

  const projectRoot = await findProjectRoot(cwd);
  if (projectRoot !== cwd) {
    if (provider.includeClaude) {
      roots.push({
        path: join(projectRoot, '.claude', 'skills'),
        source: 'project-claude',
        rank: RANKS.rootClaude,
      });
    }
    if (provider.includeAgents) {
      roots.push({
        path: join(projectRoot, '.agents', 'skills'),
        source: 'project-agents',
        rank: RANKS.rootAgents,
      });
    }
  }

  for (const dir of provider.extraDirs) {
    roots.push({
      path: isAbsolute(dir) ? dir : resolve(cwd, dir),
      source: 'project-custom',
      rank: RANKS.extra,
    });
  }

  const seen = new Set();
  return roots.filter((root) => {
    const key = resolve(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findProjectRoot(cwd) {
  let current = cwd;
  for (;;) {
    if (await pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function scanRoot(root, ctx, signal, providerName) {
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if (isAbsentPathError(error)) return [];
    warn(ctx, `project-skills: cannot read ${root.path}: ${errorMessage(error)}`);
    return [];
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  const skills = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.name === '.system') continue;
    const fullPath = join(root.path, entry.name);
    const kind = await entryKind(fullPath, entry);
    if (kind === undefined) continue;

    let locator;
    let fallbackName;
    if (kind === 'directory') {
      locator = { path: join(fullPath, 'SKILL.md'), directory: fullPath };
      fallbackName = entry.name;
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      locator = { path: fullPath, directory: root.path };
      fallbackName = entry.name.slice(0, -3);
    } else {
      continue;
    }

    const parsed = await readSkillFile(locator.path, fallbackName, ctx, signal);
    if (parsed === undefined) continue;
    // Honour a skill that explicitly opts out of user invocation: leave it to
    // the built-in provider (when one handles the same root) instead of
    // shadowing it with an entry that would go nowhere.
    if (!parsed.userInvocable) continue;

    skills.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: { modelInvocable: false, userInvocable: true },
      source: root.source,
      provider: providerName,
      rank: root.rank,
      locator: { path: parsed.path, directory: parsed.directory },
      resourceBase: { kind: 'directory', path: parsed.directory },
      path: parsed.path,
    });
  }
  return skills;
}

async function entryKind(fullPath, entry) {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return undefined;
  try {
    const info = await stat(fullPath);
    if (info.isDirectory()) return 'directory';
    if (info.isFile()) return 'file';
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Parse one skill file. Returns `undefined` for missing, malformed, or invalid
 * skills.
 * @param {string} path
 * @param {string | undefined} fallbackName
 * @param {object} ctx
 * @param {AbortSignal | undefined} signal
 * @param {{ quiet?: boolean }} [options]
 */
async function readSkillFile(path, fallbackName, ctx, signal, options = {}) {
  throwIfAborted(signal);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (!options.quiet && !isAbsentPathError(error)) {
      warn(ctx, `project-skills: cannot read ${path}: ${errorMessage(error)}`);
    }
    return undefined;
  }
  signal?.throwIfAborted();

  const parsed = parseFrontmatter(raw);
  if (parsed === undefined) {
    if (!options.quiet) warn(ctx, `project-skills: ignored ${path}: missing YAML frontmatter`);
    return undefined;
  }

  const rawName = stringField(parsed.data, 'name') ?? fallbackName;
  if (rawName === undefined || !SKILL_NAME.test(rawName)) {
    if (!options.quiet) {
      warn(ctx, `project-skills: ignored ${path}: invalid or missing skill name "${rawName ?? ''}"`);
    }
    return undefined;
  }

  const description = stringField(parsed.data, 'description')?.trim();
  if (description === undefined || description.length === 0) {
    if (!options.quiet) {
      warn(ctx, `project-skills: ignored ${path}: frontmatter requires a non-empty description`);
    }
    return undefined;
  }

  const whenToUse =
    stringField(parsed.data, 'whenToUse') ?? stringField(parsed.data, 'when-to-use');
  const userInvocable = frontmatterBoolean(parsed.data, 'user-invocable') !== false;

  let realPath;
  try {
    realPath = await realpath(path);
  } catch {
    realPath = resolve(path);
  }

  return {
    name: rawName,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    userInvocable,
    path: realPath,
    directory: dirname(realPath),
  };
}

function renderReadInstruction(skill) {
  return [
    'This project skill is stored as a file and was not loaded into this prompt.',
    '',
    `Read "${skill.path}" with the Read tool before continuing.`,
    `Then follow the instructions in that file exactly. Resolve relative paths mentioned there against "${skill.directory}".`,
    'The file is the source of truth; do not answer from this notice alone.',
  ].join('\n');
}

/** Split YAML frontmatter from a Markdown document. */
export function parseFrontmatter(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) return undefined;
  return {
    data: parseYamlObject(lines.slice(1, end)),
    body: lines.slice(end + 1).join('\n'),
  };
}

/**
 * A deliberately small YAML subset parser for skill frontmatter. It handles
 * top-level scalar keys, quoted values, booleans, and `|`/`>` block scalars.
 * Nested mappings (for example `metadata:`) are ignored, which is fine because
 * this provider does not need them.
 */
function parseYamlObject(lines) {
  const data = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue; // nested mapping or continuation
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    const rest = match[2];

    if (/^[|>][+-]?$/.test(rest)) {
      const block = readBlockScalar(lines, index + 1, rest[0], rest.slice(1));
      data[key] = block.value;
      index = block.next - 1;
      continue;
    }

    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quoted = readQuotedScalar(lines, index, rest);
      data[key] = quoted.value;
      index = quoted.next - 1;
      continue;
    }

    data[key] = coerceScalar(stripPlainComment(rest).trim());
  }
  return data;
}

function readBlockScalar(lines, start, style, chomp) {
  const collected = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().length === 0) {
      collected.push('');
      index += 1;
      continue;
    }
    if (!/^\s/.test(line)) break;
    collected.push(line);
    index += 1;
  }

  const indents = collected
    .filter((line) => line.trim().length > 0)
    .map((line) => /^[ \t]*/.exec(line)[0].length);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  const normalized = collected.map((line) => line.slice(Math.min(indent, line.length)));

  let value;
  if (style === '|') {
    value = normalized.join('\n');
  } else {
    const paragraphs = [];
    let current = [];
    for (const line of normalized) {
      if (line.trim().length === 0) {
        if (current.length > 0) {
          paragraphs.push(current.join(' '));
          current = [];
        }
        paragraphs.push('');
      } else {
        current.push(line.trim());
      }
    }
    if (current.length > 0) paragraphs.push(current.join(' '));
    value = paragraphs.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  if (chomp === '-') value = value.replace(/\n+$/, '');
  else value = value.replace(/\n+$/, '') + '\n';
  return { value, next: index };
}

function readQuotedScalar(lines, start, initial) {
  let text = initial;
  let index = start;
  while (!hasClosingQuote(text)) {
    index += 1;
    if (index >= lines.length) break;
    text += ` ${lines[index].trim()}`;
  }
  const quote = text[0];
  const end = text.lastIndexOf(quote);
  const inner = end > 0 ? text.slice(1, end) : text.slice(1);
  return {
    value: quote === '"' ? unescapeDoubleQuoted(inner) : inner.replaceAll("''", "'"),
    next: index + 1,
  };
}

function hasClosingQuote(text) {
  const quote = text[0];
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"' && char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        index += 1;
        continue;
      }
      return true;
    }
  }
  return false;
}

function unescapeDoubleQuoted(value) {
  return value.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (match, escape) => {
    switch (escape) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '/':
        return '/';
      case '\\':
        return '\\';
      case '"':
        return '"';
      default:
        return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    }
  });
}

function stripPlainComment(value) {
  return value.replace(/\s+#.*$/, '');
}

function coerceScalar(value) {
  if (value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === 'no' || value === 'off') return false;
  if (value === 'null' || value === '~') return null;
  return value;
}

function stringField(data, key) {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true;
      case 'false':
      case 'no':
      case 'off':
        return false;
      default:
        return undefined;
    }
  }
  return undefined;
}

function isDuplicateProviderError(error) {
  return /a skill provider named ".*" is already registered/.test(errorMessage(error));
}

function isAbsentPathError(error) {
  return error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function warn(ctx, message) {
  ctx?.logger?.warn?.(message);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('project-skills: aborted');
  }
}
