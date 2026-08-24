const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
// 15s was too tight under full-suite CPU contention: a scaffolding init that
// legitimately runs long got SIGTERM'd and the file flaked as a false "hung".
// 60s keeps the real-hang guard (interactive prompt waiting on stdin blocks
// forever) while clearing the load-induced slowdown.
const INIT_TIMEOUT_MS = 60000;
const FIRST_USE_NEXT = 'Next: atris "help me choose the first useful step for this project"';
const FIRST_MISSION = 'atris mission start "Verify this Atris workspace is ready" --owner validator --runner manual --lane workspace --verify "node -e \\"require(\'fs\').accessSync(\'atris/atris.md\')\\"" --stop "workspace readiness is verified"';
const STARTER_MEMBERS = ['customer-lead', 'executor', 'improver', 'mission-lead', 'navigator', 'validator'];

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-non-interactive-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function listTeamMembers(dir) {
  const teamDir = path.join(dir, 'atris', 'team');
  return fs.readdirSync(teamDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .filter((entry) => fs.existsSync(path.join(teamDir, entry.name, 'MEMBER.md')))
    .map((entry) => entry.name)
    .sort();
}

function runInit(args, { cwd, input, env } = {}) {
  return runCli(['init', ...args], { cwd, input, env, timeout: INIT_TIMEOUT_MS });
}

function runCli(args, { cwd, input, env, timeout = INIT_TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });

  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ') || '(none)'})`);
  }

  if (result.error) {
    throw result.error;
  }

  return result;
}

test('init --yes exits without hanging and skips context gatherer', () => {
  const dir = makeTempDir();
  try {
    const res = runInit(['--yes'], { cwd: dir });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stdout, /context gatherer skipped/);
    assert.ok(res.stdout.includes('  next     run `atris` and describe what you want in plain words.'));
    assert.ok(res.stdout.includes(`agents: ${FIRST_MISSION}`));
    assert.ok(res.stdout.includes(`Then: ${FIRST_USE_NEXT.slice('Next: '.length)}`));
    assert.doesNotMatch(res.stdout, /BOOTSTRAP REQUIRED|generate a complete `atris\/MAP\.md`/);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('init -y exits without hanging and skips context gatherer', () => {
  const dir = makeTempDir();
  try {
    const res = runInit(['-y'], { cwd: dir });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stdout, /context gatherer skipped/);
    assert.ok(res.stdout.includes('  next     run `atris` and describe what you want in plain words.'));
    assert.ok(res.stdout.includes(`agents: ${FIRST_MISSION}`));
    assert.ok(res.stdout.includes(`Then: ${FIRST_USE_NEXT.slice('Next: '.length)}`));
    assert.doesNotMatch(res.stdout, /BOOTSTRAP REQUIRED|generate a complete `atris\/MAP\.md`/);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('init with piped stdin exits without hanging', () => {
  const dir = makeTempDir();
  try {
    const res = runInit([], { cwd: dir, input: '' });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stdout, /context gatherer skipped/);
    assert.ok(res.stdout.includes('  next     run `atris` and describe what you want in plain words.'));
    assert.ok(res.stdout.includes(`agents: ${FIRST_MISSION}`));
    assert.ok(res.stdout.includes(`Then: ${FIRST_USE_NEXT.slice('Next: '.length)}`));
    assert.doesNotMatch(res.stdout, /BOOTSTRAP REQUIRED|generate a complete `atris\/MAP\.md`/);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'atris.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('init with ATRIS_NO_INTERACTIVE skips context gatherer', () => {
  const dir = makeTempDir();
  try {
    const res = runInit([], { cwd: dir, env: { ATRIS_NO_INTERACTIVE: '1' } });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stdout, /context gatherer skipped/);
    assert.ok(res.stdout.includes('  next     run `atris` and describe what you want in plain words.'));
    assert.ok(res.stdout.includes(`agents: ${FIRST_MISSION}`));
    assert.ok(res.stdout.includes(`Then: ${FIRST_USE_NEXT.slice('Next: '.length)}`));
    assert.doesNotMatch(res.stdout, /BOOTSTRAP REQUIRED|generate a complete `atris\/MAP\.md`/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('init keeps default output grouped and restores file details with --verbose', () => {
  const quietDir = makeTempDir();
  const verboseDir = makeTempDir();
  try {
    const quiet = runInit(['--yes'], { cwd: quietDir });
    assert.equal(quiet.status, 0, `stdout:\n${quiet.stdout}\nstderr:\n${quiet.stderr}`);
    assert.doesNotMatch(quiet.stdout, /CONTEXT LOADED/);
    assert.doesNotMatch(quiet.stdout, /✓ Copied skill:|\.claude\/skills\//);
    assert.match(quiet.stdout, /workspace files ready \(\d+\)/);
    assert.match(quiet.stdout, /team members ready \(6\)/);
    assert.match(quiet.stdout, /^more members are available with atris member create <name>$/m);
    assert.match(quiet.stdout, /agent adapters ready \(\d+\)/);
    assert.match(quiet.stdout, /skills installed \(\d+\)/);

    const verbose = runInit(['--yes', '--verbose'], { cwd: verboseDir });
    assert.equal(verbose.status, 0, `stdout:\n${verbose.stdout}\nstderr:\n${verbose.stderr}`);
    assert.match(verbose.stdout, /✓ Created GETTING_STARTED\.md/);
    assert.match(verbose.stdout, /✓ Copied skill:/);
    assert.match(verbose.stdout, /context gatherer skipped \(non-interactive\)\./);
  } finally {
    cleanupTempDir(quietDir);
    cleanupTempDir(verboseDir);
  }
});

test('fresh init creates the six-member starter team with a safe customer lead', () => {
  const dir = makeTempDir();
  try {
    const res = runInit(['--yes'], { cwd: dir });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.deepEqual(listTeamMembers(dir), STARTER_MEMBERS);
    const customerLeadDir = path.join(dir, 'atris', 'team', 'customer-lead');
    assert.ok(fs.existsSync(path.join(customerLeadDir, 'SOUL.md')));
    assert.ok(fs.existsSync(path.join(customerLeadDir, 'START_HERE.md')));
    assert.ok(fs.existsSync(path.join(customerLeadDir, 'skills', 'customer-commitments', 'SKILL.md')));
    assert.ok(fs.statSync(path.join(customerLeadDir, 'tools')).isDirectory());
    assert.ok(fs.statSync(path.join(customerLeadDir, 'context')).isDirectory());
    assert.match(fs.readFileSync(path.join(customerLeadDir, 'MEMBER.md'), 'utf8'), /can-send: false/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('force init and update preserve extra members in an existing workspace', () => {
  const dir = makeTempDir();
  try {
    const init = runInit(['--yes'], { cwd: dir });
    assert.equal(init.status, 0, `stdout:\n${init.stdout}\nstderr:\n${init.stderr}`);

    const extraMemberDir = path.join(dir, 'atris', 'team', 'customer-guide');
    const extraMemberFile = path.join(extraMemberDir, 'MEMBER.md');
    fs.mkdirSync(extraMemberDir, { recursive: true });
    fs.writeFileSync(extraMemberFile, '# Customer Guide\n', 'utf8');

    const forcedInit = runInit(['--yes', '--force'], { cwd: dir });
    assert.equal(forcedInit.status, 0, `stdout:\n${forcedInit.stdout}\nstderr:\n${forcedInit.stderr}`);
    assert.equal(fs.readFileSync(extraMemberFile, 'utf8'), '# Customer Guide\n');

    const update = runCli(['update', '--yes'], { cwd: dir });
    assert.equal(update.status, 0, `stdout:\n${update.stdout}\nstderr:\n${update.stderr}`);
    assert.equal(fs.readFileSync(extraMemberFile, 'utf8'), '# Customer Guide\n');
  } finally {
    cleanupTempDir(dir);
  }
});

test('first-use command after init creates a starter task instead of MAP homework', () => {
  const dir = makeTempDir();
  try {
    const init = runInit(['--yes'], { cwd: dir });
    assert.equal(init.status, 0, `stdout:\n${init.stdout}\nstderr:\n${init.stderr}`);

    const res = runCli(['help me choose the first useful step for this project'], { cwd: dir });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stdout, /First task: [A-Z]+-\d+/);
    assert.match(res.stdout, /Next: atris task claim [A-Z]+-\d+ --as /);
    assert.match(res.stdout, /next setup: open atris\/MAP\.md, then claim the starter task\./);
    assert.doesNotMatch(res.stdout, /^Mission: atris mission start/m);
    assert.doesNotMatch(res.stdout, /BOOTSTRAP REQUIRED|generate a complete `atris\/MAP\.md`/);
  } finally {
    cleanupTempDir(dir);
  }
});
