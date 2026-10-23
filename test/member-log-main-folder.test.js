'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { appendMemberDailyEntry, todayLogName } = require('../lib/daily-log');

const HOOK = path.join(__dirname, '..', 'scripts', 'pre-commit');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function project(t, members = ['builder']) {
  const main = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'member-log-main-')));
  t.after(() => fs.rmSync(main, { recursive: true, force: true }));
  git(main, ['init', '-q', '-b', 'master']);
  git(main, ['config', 'user.email', 'test@example.com']);
  git(main, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(main, '.gitignore'), 'atris/team/*/logs/\n');
  for (const member of members) {
    fs.mkdirSync(path.join(main, 'atris', 'team', member), { recursive: true });
    fs.writeFileSync(path.join(main, 'atris', 'team', member, 'MEMBER.md'), `# ${member}\n`);
  }
  fs.mkdirSync(path.join(main, 'scripts'));
  fs.writeFileSync(path.join(main, 'scripts', 'precommit-load-check.js'), '');
  git(main, ['add', '-A']);
  git(main, ['commit', '-q', '-m', 'seed']);
  return main;
}

function workFolder(t, main, name = 'work') {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'member-log-wt-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, name);
  git(main, ['worktree', 'add', '-q', '-b', name, dir]);
  return dir;
}

function logFile(root, member) {
  return path.join(root, 'atris', 'team', member, 'logs', todayLogName());
}

test('a member log written from a work folder lands in the main project folder', (t) => {
  const main = project(t);
  const work = workFolder(t, main);

  const written = appendMemberDailyEntry(work, 'builder', 'Task claimed', { task: 'one' });

  assert.strictEqual(written, logFile(main, 'builder'));
  assert.match(fs.readFileSync(logFile(main, 'builder'), 'utf8'), /Task claimed[\s\S]*- task: one/);
  assert.strictEqual(fs.existsSync(logFile(work, 'builder')), false);
});

test('the log survives the work folder being removed', (t) => {
  const main = project(t);
  const work = workFolder(t, main);
  appendMemberDailyEntry(work, 'builder', 'Task claimed', { task: 'two' });

  git(main, ['worktree', 'remove', '--force', work]);

  assert.match(fs.readFileSync(logFile(main, 'builder'), 'utf8'), /- task: two/);
});

test('the main project folder still writes its own log in place', (t) => {
  const main = project(t);
  assert.strictEqual(appendMemberDailyEntry(main, 'builder', 'Task claimed', {}), logFile(main, 'builder'));
});

test('a member only the work folder knows keeps its log in the work folder', (t) => {
  const main = project(t);
  const work = workFolder(t, main);
  fs.mkdirSync(path.join(work, 'atris', 'team', 'newcomer'), { recursive: true });
  fs.writeFileSync(path.join(work, 'atris', 'team', 'newcomer', 'MEMBER.md'), '# newcomer\n');

  assert.strictEqual(appendMemberDailyEntry(work, 'newcomer', 'Task claimed', {}), logFile(work, 'newcomer'));
});

function runHook(cwd) {
  return spawnSync('sh', [HOOK], { cwd, encoding: 'utf8' });
}

test('the commit hook refuses a member log even when it is force-added', (t) => {
  const main = project(t);
  const work = workFolder(t, main);
  fs.mkdirSync(path.dirname(logFile(work, 'builder')), { recursive: true });
  fs.writeFileSync(logFile(work, 'builder'), '## note\n');
  git(work, ['add', '-f', path.relative(work, logFile(work, 'builder'))]);

  const blocked = runHook(work);
  assert.strictEqual(blocked.status, 1);
  assert.match(blocked.stdout, /local member memory and must not be committed/);

  git(work, ['restore', '--staged', 'atris/team']);
  fs.writeFileSync(path.join(work, 'feature.js'), 'module.exports = 1;\n');
  git(work, ['add', 'feature.js']);
  assert.strictEqual(runHook(work).status, 0);
});
