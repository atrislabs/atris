'use strict';

// Dedicated coverage for commands/brain.js (the brain compile/activate surface).
// Sibling files cover narrow slices (brain-count-todo-items, brain-contribution-card-escaping);
// this file covers the compile/activate lifecycle gaps: artifact writing, --json success
// shape, idempotent recompile (generated blocks replace in place, never duplicate),
// operator prose survival around the generated block, activate --verify exit codes with
// plain messages, flag forms (--root=, status alias, help, unknown subcommand), and the
// exported pure helpers (verifyActivationCard, verifyActivationGallery, collectState,
// renderStatus).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const {
  collectState,
  renderStatus,
  verifyActivationCard,
  verifyActivationGallery,
} = require('../commands/brain');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brain-cmd-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

// Seeds the minimal atris/ workspace the brain compiles from: MAP, TODO, wiki
// status, one ready member, and one state row so the compile has real signal.
function seedWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'justin'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
    slug: 'brain-lab',
    name: 'Brain Lab',
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'now.md'), '', 'utf8');
  fs.rmSync(path.join(dir, 'atris', 'now.md'), { force: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Brain Lab Map\n\n| Path | What |\n|---|---|\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
    '# TODO',
    '',
    '## Endgame',
    '',
    '**Slug:** demo-horizon',
    '**Horizon:** Ship the demo',
    '',
    '## Backlog',
    '',
    '- [ ] **Ship:** one thing',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), '# Wiki Status\n\n- Health: seeded\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'MEMBER.md'), '# Justin McDonald\n\nForward Deployed GTM Operator\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'justin', 'START_HERE.md'), '# Justin Start Here\n\nPick one customer-moving GTM rep.\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'agent_mail.jsonl'), JSON.stringify({
    ts: '2026-04-29T00:00:00Z',
    subject: 'hello',
  }) + '\n', 'utf8');
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

// Compile timestamps differ per run by design; strip them before diffing.
function stripTimestamps(text) {
  return text
    .replace(/^- Generated: .*$/gm, '- Generated: <ts>')
    .replace(/^Generated: .*$/gm, 'Generated: <ts>')
    .replace(/Last compile: .*$/gm, 'Last compile: <ts>')
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<ts>');
}

test('brain compile writes STATUS.md, ledger, and state.json from a seeded workspace', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris brain compiled/);
    assert.match(res.stdout, /Verify: passed/);

    const brainDir = path.join(dir, 'atris', 'brain');
    const status = fs.readFileSync(path.join(brainDir, 'STATUS.md'), 'utf8');
    assert.match(status, /# Atris Brain Status/);
    assert.match(status, /Workspace: Brain Lab/);
    assert.match(status, /## Loop Health/);
    assert.match(status, /## Next Move/);
    assert.match(status, /## Load Order For Future Agents/);

    const ledger = fs.readFileSync(path.join(brainDir, 'self_improvement_ledger.md'), 'utf8');
    assert.match(ledger, /## Run N -> Run N\+1 Mechanism/);

    const state = JSON.parse(fs.readFileSync(path.join(brainDir, 'state.json'), 'utf8'));
    assert.equal(state.name, 'Brain Lab');
    assert.equal(state.totalRows, 1);
    assert.equal(state.validRows, 1);

    // The boot block lands in every root agent adapter.
    for (const adapter of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      const text = fs.readFileSync(path.join(dir, adapter), 'utf8');
      assert.match(text, /Atris Brain Compile/, `${adapter} should carry the boot block`);
      assert.match(text, /atris brain activate --root \. --yes --verify/, `${adapter} should name the activation command`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain compile --json returns ok true with state and written artifact paths', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const res = runCli(['brain', 'compile', '--yes', '--root', dir, '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.state.name, 'Brain Lab');
    assert.equal(fs.existsSync(payload.written.statusPath), true);
    assert.equal(fs.existsSync(payload.written.ledgerPath), true);
    assert.equal(fs.existsSync(payload.written.jsonPath), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('recompile with unchanged inputs is idempotent: same artifacts, one boot block, no growth', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    assert.equal(runCli(['brain', 'compile', '--yes', '--root', dir], { cwd: dir }).status, 0);
    const firstStatus = fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8');
    const firstAgents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');

    assert.equal(runCli(['brain', 'compile', '--yes', '--root', dir], { cwd: dir }).status, 0);
    const secondStatus = fs.readFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), 'utf8');
    const secondAgents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');

    // Only the compile timestamp may differ between runs on identical inputs.
    assert.equal(stripTimestamps(secondStatus), stripTimestamps(firstStatus));
    assert.equal(stripTimestamps(secondAgents), stripTimestamps(firstAgents));

    // The generated block is replaced in place, never appended a second time.
    for (const adapter of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      const text = fs.readFileSync(path.join(dir, adapter), 'utf8');
      assert.equal(countOccurrences(text, '<!-- ATRIS_BRAIN_COMPILE:START -->'), 1,
        `${adapter} should hold exactly one generated block after recompile`);
    }
    const wikiStatus = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), 'utf8');
    assert.equal(countOccurrences(wikiStatus, '<!-- ATRIS_BRAIN_COMPILE:START -->'), 1,
      'wiki STATUS.md should hold exactly one brain compile block after recompile');
  } finally {
    cleanupTempDir(dir);
  }
});

test('recompile preserves operator prose around the generated block', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), [
      '# AGENTS',
      '',
      'Hand-written onboarding the compile must not eat.',
      '',
      '<!-- ATRIS_BRAIN_COMPILE:START -->',
      'stale generated content',
      '<!-- ATRIS_BRAIN_COMPILE:END -->',
      '',
      'Hand-written footer that also survives.',
      '',
    ].join('\n'), 'utf8');

    assert.equal(runCli(['brain', 'compile', '--yes', '--root', dir], { cwd: dir }).status, 0);
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Hand-written onboarding the compile must not eat\./);
    assert.match(agents, /Hand-written footer that also survives\./);
    assert.doesNotMatch(agents, /stale generated content/);
    assert.match(agents, /Atris Brain Compile/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate --verify on a ready member exits 0 with an executable card', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const res = runCli(['brain', 'activate', '--yes', '--member', 'justin', '--root', dir, '--verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /CONTEXT: Brain Lab Brain/);
    assert.match(res.stdout, /OPERATOR: Justin McDonald/);
    assert.match(res.stdout, /VERIFY: brain artifacts and member activation executable/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brain activate --verify on a missing member exits nonzero with a plain message, no stack trace', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    const res = runCli(['brain', 'activate', '--yes', '--member', 'ghost', '--root', dir, '--verify'], { cwd: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /OPERATOR: ghost \(missing\)/);
    assert.match(res.stderr, /brain activate non-executable member activation card: ghost \(missing\)/);
    assert.doesNotMatch(res.stderr, /at \w+ \(|Error:|node:internal/,
      'verify failure must read as a plain sentence, not a stack trace');
  } finally {
    cleanupTempDir(dir);
  }
});

test('flag handling: --root= equals form and the status alias both compile from a foreign cwd', () => {
  const dir = makeTempDir();
  const elsewhere = makeTempDir();
  try {
    seedWorkspace(dir);
    const res = runCli(['brain', 'status', '--yes', `--root=${dir}`, '--verify'], { cwd: elsewhere });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris brain compiled/);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'brain', 'STATUS.md')), true);
    // The compile must land in --root, never the spawn cwd.
    assert.equal(fs.existsSync(path.join(elsewhere, 'atris', 'brain')), false);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(elsewhere);
  }
});

test('brain help exits 0 with usage; an unknown subcommand exits 1 with usage on stderr', () => {
  const dir = makeTempDir();
  try {
    const help = runCli(['brain', 'help'], { cwd: dir });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: atris brain compile/);

    const unknown = runCli(['brain', 'defragment', '--root', dir], { cwd: dir });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Usage: atris brain compile/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('verifyActivationCard passes ready cards and rejects missing or not-ready operators with plain messages', () => {
  assert.doesNotThrow(() => verifyActivationCard('CONTEXT: Lab Brain\nOPERATOR: Justin McDonald\nNEXT MOVE: ship'));
  assert.throws(
    () => verifyActivationCard('CONTEXT: Lab Brain\nOPERATOR: ghost (missing)\nNEXT MOVE: create the member'),
    /non-executable member activation card: ghost \(missing\)/,
  );
  assert.throws(
    () => verifyActivationCard('CONTEXT: Lab Brain\nOPERATOR: Justin (not ready)\nNEXT MOVE: fill the profile'),
    /non-executable member activation card: Justin \(not ready\)/,
  );
});

test('verifyActivationGallery names every not-ready member across cards', () => {
  const gallery = [
    'CONTEXT: Lab Brain\nOPERATOR: Justin McDonald\nNEXT MOVE: ship',
    'CONTEXT: Lab Brain\nOPERATOR: ghost (missing)\nNEXT MOVE: create',
    'CONTEXT: Lab Brain\nOPERATOR: intern (not ready)\nNEXT MOVE: finish profile',
  ].join('\n\n---\n\n');
  assert.throws(
    () => verifyActivationGallery(gallery),
    /ghost \(missing\), intern \(not ready\)/,
  );
  assert.doesNotThrow(() => verifyActivationGallery('CONTEXT: Lab Brain\nOPERATOR: Justin McDonald\nNEXT MOVE: ship'));
});

test('collectState reads the seeded workspace shape: name, todo counts, endgame, load flags', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'now.md'), '# now\n\nseeded front door\n', 'utf8');
    const state = collectState(dir);
    assert.equal(state.name, 'Brain Lab');
    assert.equal(state.slug, 'brain-lab');
    assert.equal(state.hasNow, true);
    assert.equal(state.hasMap, true);
    assert.equal(state.hasWikiStatus, true);
    assert.equal(state.todo.open, 1);
    assert.deepEqual(state.endgame, { slug: 'demo-horizon', horizon: 'Ship the demo', source: null });

    const status = renderStatus(state);
    assert.match(status, /Workspace: Brain Lab/);
    assert.match(status, /TODO open estimate: 1/);
    assert.match(status, /## Loop Health/);
    assert.match(status, /## Load Order For Future Agents/);
    assert.match(status, /1\. `atris\/now\.md`/);
  } finally {
    cleanupTempDir(dir);
  }
});
