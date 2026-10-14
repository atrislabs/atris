'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
// Matches init-non-interactive.test.js: scaffolding under suite load can run
// long, so keep the real-hang guard loose.
const TIMEOUT_MS = 60000;

// A project dir inside its own temp root, with a throwaway HOME so the
// skills sync that follows init/update --yes stays inside the sandbox.
function makeProject({ git = true, gitignore } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-gitignore-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (git) {
    const res = spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  }
  if (gitignore !== undefined) {
    fs.writeFileSync(path.join(project, '.gitignore'), gitignore);
  }
  return { root, project, home };
}

function runCli(args, { cwd, home }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input: '',
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: {
      ...scrubAgentEnv(),
      HOME: home,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function readGitignore(project) {
  const file = path.join(project, '.gitignore');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test('fresh init in a git repo creates .gitignore with the run output lines', () => {
  const fixture = makeProject();
  try {
    const res = runCli(['init', '--yes'], { cwd: fixture.project, home: fixture.home });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(
      readGitignore(fixture.project),
      '# atris run output\natris/runs/\natris/status/\n'
    );
  } finally {
    cleanup(fixture);
  }
});

test('init keeps existing .gitignore content and appends only missing lines', () => {
  // Existing entries stay put; atris/runs/ is already ignored so only
  // atris/status/ lands under the comment. No trailing newline after .env on
  // purpose: the append must terminate that line, not merge with it.
  const fixture = makeProject({ gitignore: 'node_modules/\natris/runs/\n.env' });
  try {
    const res = runCli(['init', '--yes'], { cwd: fixture.project, home: fixture.home });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const content = readGitignore(fixture.project);
    assert.equal(
      content,
      'node_modules/\natris/runs/\n.env\n\n# atris run output\natris/status/\n'
    );
    assert.equal(content.match(/atris\/runs\//g).length, 1);
  } finally {
    cleanup(fixture);
  }
});

test('running init twice adds nothing to .gitignore', () => {
  const fixture = makeProject();
  try {
    const first = runCli(['init', '--yes'], { cwd: fixture.project, home: fixture.home });
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    const afterFirst = readGitignore(fixture.project);

    const second = runCli(['init', '--yes', '--force'], { cwd: fixture.project, home: fixture.home });
    assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    assert.equal(readGitignore(fixture.project), afterFirst);
    assert.equal(afterFirst.match(/atris\/status\//g).length, 1);
  } finally {
    cleanup(fixture);
  }
});

test('init in a folder that is not a git repo writes no .gitignore', () => {
  const fixture = makeProject({ git: false });
  try {
    const res = runCli(['init', '--yes'], { cwd: fixture.project, home: fixture.home });
    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(readGitignore(fixture.project), null);
  } finally {
    cleanup(fixture);
  }
});

test('update without --yes lists the .gitignore change but writes nothing', () => {
  const fixture = makeProject({ gitignore: 'node_modules/\n' });
  try {
    // Minimal legacy workspace so `atris update` has a target to sync.
    fs.mkdirSync(path.join(fixture.project, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(fixture.project, 'atris', 'atris.md'), 'old spec\n');

    const preview = runCli(['update'], { cwd: fixture.project, home: fixture.home });
    // Non-TTY plan-only runs exit 2 by design.
    assert.equal(preview.status, 2, `stdout:\n${preview.stdout}\nstderr:\n${preview.stderr}`);
    assert.match(preview.stdout, /Would update \.gitignore/);
    assert.equal(readGitignore(fixture.project), 'node_modules/\n', 'preview wrote .gitignore');

    const dryRun = runCli(['update', '--dry-run'], { cwd: fixture.project, home: fixture.home });
    assert.equal(dryRun.status, 0, `stdout:\n${dryRun.stdout}\nstderr:\n${dryRun.stderr}`);
    assert.match(dryRun.stdout, /Would update \.gitignore/);
    assert.equal(readGitignore(fixture.project), 'node_modules/\n', 'dry-run wrote .gitignore');
  } finally {
    cleanup(fixture);
  }
});

test('update --yes writes the missing run output lines once', () => {
  const fixture = makeProject({ gitignore: 'node_modules/\n' });
  try {
    fs.mkdirSync(path.join(fixture.project, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(fixture.project, 'atris', 'atris.md'), 'old spec\n');

    const write = runCli(['update', '--yes'], { cwd: fixture.project, home: fixture.home });
    assert.equal(write.status, 0, `stdout:\n${write.stdout}\nstderr:\n${write.stderr}`);
    assert.match(write.stdout, /Updated \.gitignore/);
    assert.equal(
      readGitignore(fixture.project),
      'node_modules/\n\n# atris run output\natris/runs/\natris/status/\n'
    );

    const again = runCli(['update', '--yes'], { cwd: fixture.project, home: fixture.home });
    assert.equal(again.status, 0, `stdout:\n${again.stdout}\nstderr:\n${again.stderr}`);
    assert.equal(
      readGitignore(fixture.project),
      'node_modules/\n\n# atris run output\natris/runs/\natris/status/\n'
    );
  } finally {
    cleanup(fixture);
  }
});
