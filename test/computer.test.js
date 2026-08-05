// Hermetic coverage for commands/computer.js: argument parsing, plan/option
// shaping, validation and refusal paths, and output formatting. Nothing here
// spawns real automation; CLI smokes run from temp cwds with an empty HOME so
// every path stops at parsing, help, or the login guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseComputerOptions,
  parseComputerCreateArgs,
  computerCreateArgsHaveName,
  normalizeComputerType,
  formatComputerTypeList,
  parseComputerDeleteArgs,
  parseComputerCardArgs,
  buildComputerCard,
  renderComputerCard,
  renderComputerCardMarkdown,
  formatLeaseAge,
  formatWorkspaceRef,
  workspaceMatchesInput,
  resolveWorkspaceFromList,
  workspaceMatchesComputerType,
  looksLikeWorkspaceId,
  shellQuote,
  withoutRecruitingWrapperFlags,
  formatCloudSelection,
} = require('../commands/computer');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-computer-guards-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function withCleanWorkerEnv(fn) {
  const savedWorker = process.env.ATRIS_CLOUD_WORKER;
  const savedModel = process.env.ATRIS_CLOUD_MODEL;
  delete process.env.ATRIS_CLOUD_WORKER;
  delete process.env.ATRIS_CLOUD_MODEL;
  try {
    return fn();
  } finally {
    if (savedWorker !== undefined) process.env.ATRIS_CLOUD_WORKER = savedWorker;
    if (savedModel !== undefined) process.env.ATRIS_CLOUD_MODEL = savedModel;
  }
}

function runCli(args, cwd, home) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', HOME: home };
  delete env.ATRIS_CLOUD_WORKER;
  delete env.ATRIS_CLOUD_MODEL;
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
}

// --- option parsing -------------------------------------------------------

test('computer options default to wait-and-run with nothing selected', () => {
  withCleanWorkerEnv(() => {
    const parsed = parseComputerOptions([]);
    assert.deepEqual(parsed.positional, []);
    assert.deepEqual(parsed.options, {
      worker: null,
      model: null,
      businessSlug: null,
      workspaceId: null,
      waitForResult: true,
      message: null,
      force: false,
    });
  });
});

test('computer options parse both flag spellings and keep positionals in order', () => {
  withCleanWorkerEnv(() => {
    const parsed = parseComputerOptions([
      'status',
      '--business', ' my-lab ',
      '--workspace=ws-abc',
      '--worker', 'claude',
      '--model=opus',
      '--message=do the thing',
      '--no-wait',
      '--force',
      'extra',
    ]);
    assert.deepEqual(parsed.positional, ['status', 'extra']);
    assert.equal(parsed.options.businessSlug, 'my-lab');
    assert.equal(parsed.options.workspaceId, 'ws-abc');
    assert.equal(parsed.options.worker, 'claude');
    assert.equal(parsed.options.model, 'opus');
    assert.equal(parsed.options.message, 'do the thing');
    assert.equal(parsed.options.waitForResult, false);
    assert.equal(parsed.options.force, true);
  });
});

test('computer options treat --async like --no-wait and -b like --business', () => {
  withCleanWorkerEnv(() => {
    const parsed = parseComputerOptions(['exec', '-b', 'acme', '--async']);
    assert.equal(parsed.options.businessSlug, 'acme');
    assert.equal(parsed.options.waitForResult, false);
    assert.deepEqual(parsed.positional, ['exec']);
  });
});

// --- create args ----------------------------------------------------------

test('computer create args join the name and normalize the type', () => {
  const parsed = parseComputerCreateArgs(['Hiring', 'Computer', '--type', 'Event Ops', '--business', 'my-lab', '--set-default']);
  assert.equal(parsed.name, 'Hiring Computer');
  assert.equal(parsed.computerType, 'event_ops');
  assert.equal(parsed.businessSlug, 'my-lab');
  assert.equal(parsed.setDefault, true);
  assert.equal(parsed.help, false);
});

test('computer create args refuse to eat a flag as the type value', () => {
  // Known wart, pinned: the unconsumed --type token falls through into the
  // name parts instead of being dropped or rejected.
  const parsed = parseComputerCreateArgs(['--type', '--set-default', 'Box']);
  assert.equal(parsed.computerType, null);
  assert.equal(parsed.setDefault, true);
  assert.equal(parsed.name, '--type Box');
});

test('computer create help spellings all mark help without inventing a name', () => {
  for (const spelling of ['--help', '-h', 'help']) {
    const parsed = parseComputerCreateArgs([spelling]);
    assert.equal(parsed.help, true, spelling);
    assert.equal(parsed.name, '');
  }
});

test('computer create name detection skips flag values so bare flags mean no name', () => {
  assert.equal(computerCreateArgsHaveName(['--business', 'my-lab', '--type', 'crm']), false);
  assert.equal(computerCreateArgsHaveName(['help']), false);
  assert.equal(computerCreateArgsHaveName(['--set-default']), false);
  assert.equal(computerCreateArgsHaveName(['--business', 'my-lab', 'Hiring']), true);
});

test('computer type normalization maps aliases and never returns empty', () => {
  assert.equal(normalizeComputerType('business'), 'business_ops');
  assert.equal(normalizeComputerType('event'), 'event_ops');
  assert.equal(normalizeComputerType('Event-Ops'), 'event_ops');
  assert.equal(normalizeComputerType('  CRM  '), 'crm');
  assert.equal(normalizeComputerType(''), 'general');
  assert.equal(normalizeComputerType(null), 'general');
});

test('computer type list names every valid type', () => {
  const list = formatComputerTypeList();
  for (const type of ['general', 'business_ops', 'codeops', 'research', 'crm', 'reporting', 'recruiting', 'event_ops', 'support']) {
    assert.ok(list.includes(type), type);
  }
});

// --- delete + card args ---------------------------------------------------

test('computer delete args capture the typed confirmation in both spellings', () => {
  assert.equal(parseComputerDeleteArgs(['--confirm', 'delete ws_1']).confirm, 'delete ws_1');
  assert.equal(parseComputerDeleteArgs(['--confirm=delete ws_1']).confirm, 'delete ws_1');
  assert.equal(parseComputerDeleteArgs([]).confirm, null);
  assert.equal(parseComputerDeleteArgs(['--help']).help, true);
});

test('computer card args parse write and out in both spellings', () => {
  assert.deepEqual(parseComputerCardArgs(['--write']), { write: true, out: null, help: false });
  assert.equal(parseComputerCardArgs(['--out', 'card.md']).out, 'card.md');
  assert.equal(parseComputerCardArgs(['--out=card.md']).out, 'card.md');
  assert.equal(parseComputerCardArgs(['-h']).help, true);
});

// --- card building + rendering -------------------------------------------

test('computer card built from a bare folder falls back to folder identity', () => {
  const dir = makeTempDir();
  try {
    const card = buildComputerCard(dir);
    assert.equal(card.ownerName, path.basename(dir));
    assert.equal(card.ownerType, 'project');
    assert.equal(card.computerName, `${path.basename(dir)} computer`);
    assert.equal(card.workspace, dir);
    assert.deepEqual(card.memory, []);

    const text = renderComputerCard(card);
    assert.ok(text.startsWith('Atris Computer Card'));
    assert.ok(text.includes('Memory:     none detected'));

    const markdown = renderComputerCardMarkdown(card);
    assert.ok(markdown.startsWith('# Atris Computer Card'));
    assert.ok(markdown.includes(`- Workspace: ${dir}`));
  } finally {
    cleanupTempDir(dir);
  }
});

// --- workspace matching ---------------------------------------------------

test('workspace matching is case-insensitive on id and name and refuses blanks', () => {
  const workspace = { id: 'WS-Abc', name: 'Hiring Computer' };
  assert.equal(workspaceMatchesInput(workspace, 'ws-abc'), true);
  assert.equal(workspaceMatchesInput(workspace, 'hiring computer'), true);
  assert.equal(workspaceMatchesInput(workspace, '  '), false);
  assert.equal(workspaceMatchesInput(workspace, null), false);
  assert.equal(workspaceMatchesInput(null, 'ws-abc'), false);
});

test('workspace list resolution returns the match or null, never a guess', () => {
  const list = [{ id: 'ws-1', name: 'alpha' }, { id: 'ws-2', name: 'beta' }];
  assert.equal(resolveWorkspaceFromList(list, 'beta').id, 'ws-2');
  assert.equal(resolveWorkspaceFromList(list, 'gamma'), null);
  assert.equal(resolveWorkspaceFromList(null, 'alpha'), null);
});

test('workspace type matching accepts typed field or compacted name mention', () => {
  assert.equal(workspaceMatchesComputerType({ computer_type: 'recruiting' }, 'recruiting'), true);
  assert.equal(workspaceMatchesComputerType({ name: 'Event Ops Desk' }, 'event'), true);
  assert.equal(workspaceMatchesComputerType({ name: 'Research Bench' }, 'crm'), false);
  assert.equal(workspaceMatchesComputerType(null, 'crm'), false);
});

test('workspace id shape check accepts uuids and ws- slugs only', () => {
  assert.equal(looksLikeWorkspaceId('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(looksLikeWorkspaceId('ws-hiring_2'), true);
  assert.equal(looksLikeWorkspaceId('hiring computer'), false);
  assert.equal(looksLikeWorkspaceId(''), false);
});

// --- small formatters -----------------------------------------------------

test('lease age formatting buckets seconds into s, m, h, d and dashes junk', () => {
  assert.equal(formatLeaseAge(59), '59s');
  assert.equal(formatLeaseAge(60), '1m');
  assert.equal(formatLeaseAge(3600), '1h');
  assert.equal(formatLeaseAge(48 * 3600), '2d');
  assert.equal(formatLeaseAge(-1), '-');
  assert.equal(formatLeaseAge('nope'), '-');
});

test('workspace ref formatting shows name with id and dashes missing workspaces', () => {
  assert.equal(formatWorkspaceRef({ id: 'ws-1', name: 'alpha' }), 'alpha (ws-1)');
  assert.equal(formatWorkspaceRef({ id: 'ws-1' }), 'ws-1');
  assert.equal(formatWorkspaceRef(null), '-');
});

test('shell quoting survives embedded single quotes', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('plain'), `'plain'`);
});

test('recruiting wrapper flag strip only touches pull --apply', () => {
  assert.deepEqual(withoutRecruitingWrapperFlags('pull', ['--apply', '--verbose']), ['--verbose']);
  assert.deepEqual(withoutRecruitingWrapperFlags('push', ['--apply']), ['--apply']);
});

test('cloud selection label always names worker and model', () => {
  assert.equal(formatCloudSelection({ worker: 'openai', model: 'gpt-5.4' }), 'worker=openai model=gpt-5.4');
  assert.equal(formatCloudSelection({}), 'worker=claude model=default');
});

// --- CLI smokes (no auth, no spawn of real automation) --------------------

test('computer --help prints usage without needing login', () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  try {
    const result = runCli(['computer', '--help'], cwd, home);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Usage: atris computer'));
    assert.ok(result.stdout.includes('delete          Sleep, confirm, and delete a business computer'));
    assert.ok(!result.stdout.includes('Not logged in'));
  } finally {
    cleanupTempDir(cwd);
    cleanupTempDir(home);
  }
});

test('computer refuses an invalid cloud worker before touching auth or network', () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  try {
    const result = runCli(['computer', 'status', '--worker', 'bogus'], cwd, home);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Invalid cloud worker: bogus'));
    assert.ok(result.stderr.includes('Expected one of: claude, openai'));
  } finally {
    cleanupTempDir(cwd);
    cleanupTempDir(home);
  }
});

test('computer status without login stops at the login guard with a plain sentence', () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  try {
    const result = runCli(['computer', 'status'], cwd, home);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Not logged in. Run: atris login'));
  } finally {
    cleanupTempDir(cwd);
    cleanupTempDir(home);
  }
});

test('computer card renders locally with no login and no side effects', () => {
  const cwd = makeTempDir();
  const home = makeTempDir();
  try {
    const result = runCli(['computer', 'card'], cwd, home);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Atris Computer Card'));
    assert.ok(result.stdout.includes(`Workspace:  ${fs.realpathSync(cwd)}`));
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    cleanupTempDir(cwd);
    cleanupTempDir(home);
  }
});
