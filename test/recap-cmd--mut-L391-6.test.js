const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('an initialized workspace with no tasks recaps its saved git change', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-empty-board-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const log = console.log;
  try {
    const home = path.join(dir, 'home');
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      PATH: env.PATH || '/usr/bin:/bin',
      HOME: home,
      USERPROFILE: home,
      ATRIS_TASKS_DB: path.join(home, 'missing.db'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(home, 'missing.gitconfig'),
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_AUTHOR_DATE: '2024-06-15T12:00:00Z',
      GIT_COMMITTER_DATE: '2024-06-15T12:00:00Z',
    });
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-06-15T12:00:00Z') });
    const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    git('init');
    fs.writeFileSync(path.join(workspace, 'atris', '.gitkeep'), '');
    git('add', 'atris/.gitkeep');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Save workspace setup');

    process.chdir(workspace);
    const { recapAtris } = require('../commands/recap');
    const printed = [];
    console.log = (...parts) => printed.push(parts.join(' '));
    recapAtris([]);
    assert.deepEqual(printed, [
      'today in workspace\n1 change saved to git. latest: "Save workspace setup"',
    ]);
  } finally {
    console.log = log;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
