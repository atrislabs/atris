'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DENIED_TAGS } = require('./fleet');

const PATH_SURFACES = [
  ['middleware/proxy', /(?:^|[/_.-])(?:middleware|proxy)(?:[/_.-]|$)/i],
  ['csp', /(?:^|[/_.-])csp(?:[/_.-]|$)/i],
  ['auth', /(?:^|[/_.-])auth(?:entication|orization)?(?:[/_.-]|$)/i],
  ['session', /(?:^|[/_.-])sessions?(?:[/_.-]|$)/i],
  ['cookie', /(?:^|[/_.-])cookies?(?:[/_.-]|$)/i],
  ['cors', /(?:^|[/_.-])cors(?:[/_.-]|$)/i],
  ['sandbox', /(?:^|[/_.-])sandbox(?:[/_.-]|$)/i],
  ['permission', /(?:^|[/_.-])permissions?(?:[/_.-]|$)/i],
];

const CONTENT_SURFACES = [
  ['csp', /\bContent-Security-Policy\b/i],
  ['csp nonce', /\bnonce\b/i],
  ['iframe sandbox', /\bsandbox\s*=/i],
  ['cookie', /\bSet-Cookie\b/i],
  ['cors', /\bAccess-Control-Allow-[A-Za-z-]+\b/i],
  ['public dynamic rendering', /\bforce-dynamic\b/i],
  ['auth header', /\b(?:Authorization\s*[:=].*\bBearer\b|headers?\b[^\n]*\bauthorization\b|\bauthorization\b[^\n]*headers?\b)/i],
];

function normalizedTags(tags) {
  const list = Array.isArray(tags) ? tags : [tags];
  return list
    .flatMap((tag) => String(tag || '').split(','))
    .map((tag) => tag.trim().toLowerCase().replace(/_/g, '-'))
    .filter(Boolean);
}

function changedPathsFromDiff(diff) {
  const paths = [];
  for (const line of String(diff || '').split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      paths.push(header[1], header[2]);
      continue;
    }
    const file = line.match(/^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/);
    if (file && file[1] !== '/dev/null') paths.push(file[1]);
  }
  return Array.from(new Set(paths));
}

// Prose is not a protected surface. Docs, judge cards, wikis, journals and run
// receipts routinely *describe* CSP or force-dynamic without changing any
// behaviour — replaying this guard over 60 real commits, 5 of 6 hits were
// markdown that merely mentioned the words. A guard that pauses on every judge
// card gets switched off, which is worse than no guard. Content signals
// therefore apply to code only; PATH signals still apply to every file.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|sh|bash|zsh|sql|ya?ml|toml|env)$/i;

function isCodeFile(file) {
  const f = String(file || '').trim();
  if (!f || f === '/dev/null') return false;
  if (/\.(?:md|mdx|markdown|txt|rst|adoc)$/i.test(f)) return false;
  return CODE_FILE.test(f);
}

// Walk the diff file-by-file so a changed line is attributed to the file it
// came from, then keep only lines from code files.
function changedCodeLinesFromDiff(diff) {
  const lines = [];
  let inCode = false;
  for (const line of String(diff || '').split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      inCode = isCodeFile(header[1]) || isCodeFile(header[2]);
      continue;
    }
    if (/^(?:---|\+\+\+) /.test(line)) continue;
    if (!inCode) continue;
    if (/^[+-]/.test(line)) lines.push(line.slice(1));
  }
  return lines;
}

function matchProtectedMissionDiff(diff, { tags = [] } = {}) {
  const matches = [];
  const add = (surface, signal, detail) => {
    if (matches.some((match) => match.surface === surface && match.signal === signal && match.detail === detail)) return;
    matches.push({ surface, signal, detail });
  };

  for (const tag of normalizedTags(tags)) {
    if (DENIED_TAGS.includes(tag)) add(tag, 'tag', tag);
  }

  for (const file of changedPathsFromDiff(diff)) {
    for (const [surface, pattern] of PATH_SURFACES) {
      if (pattern.test(file)) add(surface, 'path', file);
    }
  }

  for (const line of changedCodeLinesFromDiff(diff)) {
    for (const [surface, pattern] of CONTENT_SURFACES) {
      if (pattern.test(line)) add(surface, 'content', 'changed line');
    }
  }

  return {
    protected: matches.length > 0,
    surfaces: Array.from(new Set(matches.map((match) => match.surface))),
    matches,
  };
}

function runGitDiff(git, args, root) {
  const result = git(args, root);
  if (!result || result.error || result.status !== 0) {
    const detail = result?.error?.message
      || String(result?.stderr || result?.stdout || `git ${args.join(' ')} failed`).trim();
    return { ok: false, detail: detail || 'git diff could not be read' };
  }
  return { ok: true, diff: String(result.stdout || '') };
}

// A busy workspace produces diffs far past spawnSync's 1 MB default, and the
// overflow surfaces as ENOBUFS. That failure is indistinguishable from a real
// unreadable diff, so the guard paused every tick and the verifier silently
// never ran. Give git room for a real diff instead.
const GIT_DIFF_MAX_BUFFER = 256 * 1024 * 1024;

function defaultGit(gitBin = 'git') {
  return (args, root) => spawnSync(gitBin, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: GIT_DIFF_MAX_BUFFER,
  });
}

function readMissionDiff({
  root = process.cwd(),
  baseRef = '',
  git = defaultGit(),
  includeUnstaged = true,
} = {}) {
  const parts = [];
  const staged = runGitDiff(git, ['diff', '--cached', '--no-ext-diff', '--unified=0', '--no-color', '--'], root);
  if (!staged.ok) return staged;
  parts.push(staged.diff);

  if (includeUnstaged) {
    const unstaged = runGitDiff(git, ['diff', '--no-ext-diff', '--unified=0', '--no-color', '--'], root);
    if (!unstaged.ok) return unstaged;
    parts.push(unstaged.diff);
  }

  if (baseRef) {
    const committed = runGitDiff(git, ['diff', '--no-ext-diff', '--unified=0', '--no-color', baseRef, 'HEAD', '--'], root);
    if (!committed.ok) return committed;
    parts.push(committed.diff);
  }

  return { ok: true, diff: parts.filter(Boolean).join('\n') };
}

function protectedPause(reason, detail = {}) {
  return {
    ok: false,
    allowed: false,
    status: 'paused-for-review',
    reason,
    ...detail,
  };
}

function unreadableMissionGuard(error) {
  return protectedPause('mission diff could not be read; human review is required', {
    unreadable: true,
    detail: error?.message || String(error || 'unknown diff read failure'),
    surfaces: ['unreadable diff'],
    matches: [],
  });
}

function inspectMissionProtectedDiff({
  root = process.cwd(),
  baseRef = '',
  tags = [],
  readDiff = readMissionDiff,
  git,
  includeUnstaged = true,
} = {}) {
  let read;
  try {
    read = readDiff({ root, baseRef, tags, git, includeUnstaged });
  } catch (error) {
    return unreadableMissionGuard(error);
  }
  if (!read || read.ok !== true) {
    return unreadableMissionGuard(read?.detail);
  }

  const matched = matchProtectedMissionDiff(read.diff, { tags });
  if (matched.protected) {
    return protectedPause(`protected mission surface requires human review: ${matched.surfaces.join(', ')}`, {
      unreadable: false,
      surfaces: matched.surfaces,
      matches: matched.matches,
    });
  }
  return {
    ok: true,
    allowed: true,
    status: 'clear',
    reason: 'mission diff contains no protected surface',
    unreadable: false,
    surfaces: [],
    matches: [],
  };
}

function guardMissionLanding(options = {}) {
  const inspection = inspectMissionProtectedDiff(options);
  if (!inspection.allowed) return inspection;
  const land = typeof options.land === 'function' ? options.land : () => ({ ok: true, landed: true });
  return { ...land(), protected_lane_guard: inspection };
}

function gitSubcommand(args) {
  const consumesValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (consumesValue.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '';
}

function prepareMissionGitGuard({
  root = process.cwd(),
  tags = [],
  pathValue = process.env.PATH || '',
} = {}) {
  const resolved = spawnSync('sh', ['-c', 'command -v git'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  });
  const gitBin = String(resolved.stdout || '').trim();
  if (resolved.status !== 0 || !gitBin) {
    throw new Error('mission git guard could not resolve git');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-git-'));
  const wrapper = path.join(dir, 'git');
  const modulePath = __filename;
  const config = { root: path.resolve(root), tags: normalizedTags(tags), gitBin };
  const source = [
    '#!/usr/bin/env node',
    "'use strict';",
    `const { spawnSync } = require('child_process');`,
    `const guard = require(${JSON.stringify(modulePath)});`,
    `const config = ${JSON.stringify(config)};`,
    `const args = process.argv.slice(2);`,
    `if (guard.gitSubcommand(args) === 'commit') {`,
    `  const result = guard.inspectMissionProtectedDiff({ root: config.root, tags: config.tags, includeUnstaged: false, git: guard.defaultGit(config.gitBin) });`,
    `  if (!result.allowed) {`,
    `    process.stderr.write(result.reason + '\\n');`,
    `    process.exit(78);`,
    `  }`,
    `}`,
    `const child = spawnSync(config.gitBin, args, { cwd: process.cwd(), stdio: 'inherit' });`,
    `if (child.error) { process.stderr.write(child.error.message + '\\n'); process.exit(1); }`,
    `process.exit(child.status == null ? 1 : child.status);`,
    '',
  ].join('\n');
  fs.writeFileSync(wrapper, source, { encoding: 'utf8', mode: 0o755 });

  return {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${pathValue}` },
    pathPrefix: dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

module.exports = {
  PATH_SURFACES,
  CONTENT_SURFACES,
  changedPathsFromDiff,
  changedCodeLinesFromDiff,
  isCodeFile,
  matchProtectedMissionDiff,
  readMissionDiff,
  unreadableMissionGuard,
  inspectMissionProtectedDiff,
  guardMissionLanding,
  gitSubcommand,
  defaultGit,
  prepareMissionGitGuard,
};
