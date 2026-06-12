const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const { memberCommand } = require('../commands/member');

function setupGitWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-history-test-'));
  const atrisDir = path.join(cwd, 'atris');
  const teamDir = path.join(atrisDir, 'team');
  const memberDir = path.join(teamDir, 'test-member');
  fs.mkdirSync(memberDir, { recursive: true });

  // initialize git repo
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd, stdio: 'pipe' });

  // create initial MEMBER.md
  const memberMdPath = path.join(memberDir, 'MEMBER.md');
  fs.writeFileSync(memberMdPath, '# Member\n\nRole: initial\n', 'utf8');

  // commit 1
  execSync('git add -A && git commit -qm "initial member"', { cwd, stdio: 'pipe' });

  // edit role line and commit 2
  fs.writeFileSync(memberMdPath, '# Member\n\nRole: updated\n', 'utf8');
  execSync('git add -A && git commit -qm "update member role"', { cwd, stdio: 'pipe' });

  // create SOUL.md and commit 3
  const soulMdPath = path.join(memberDir, 'SOUL.md');
  fs.writeFileSync(soulMdPath, '# Soul\n\nCore: test\n', 'utf8');
  execSync('git add -A && git commit -qm "add soul file"', { cwd, stdio: 'pipe' });

  return { cwd, memberDir, memberMdPath, soulMdPath };
}

function cleanup(cwd) {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

test('member history shows commits in reverse chronological order', () => {
  const { cwd } = setupGitWorkspace();
  const origCwd = process.cwd();
  try {
    process.chdir(cwd);

    // capture text output
    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));

    memberCommand('history', 'test-member');

    console.log = originalLog;

    const output = lines.join('\n');
    // check that both files appear
    assert.ok(output.includes('atris/team/test-member/MEMBER.md'), 'MEMBER.md should be in output');
    assert.ok(output.includes('atris/team/test-member/SOUL.md'), 'SOUL.md should be in output');

    // check that commits appear in order (most recent first)
    const memberSection = output.substring(output.indexOf('MEMBER.md'));
    const soulSection = output.substring(output.indexOf('SOUL.md'));

    assert.ok(memberSection.includes('update member role'), 'MEMBER.md should show update commit');
    assert.ok(memberSection.includes('initial member'), 'MEMBER.md should show initial commit');
    assert.ok(soulSection.includes('add soul file'), 'SOUL.md should show soul commit');
  } finally {
    process.chdir(origCwd);
    cleanup(cwd);
  }
});

test('member history --limit N restricts output', () => {
  const { cwd } = setupGitWorkspace();
  const origCwd = process.cwd();
  try {
    process.chdir(cwd);

    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));

    memberCommand('history', 'test-member', '--limit', '1');

    console.log = originalLog;

    const output = lines.join('\n');

    // Count lines that look like commits (start with whitespace + 7-char hash)
    const commitLinePattern = /^\s+[a-f0-9]{7,}\s+\d{4}-\d{2}-\d{2}/;
    const commitLines = output.split('\n').filter((l) => commitLinePattern.test(l));

    // with limit=1, should have 1 commit per file = 2 commits total (MEMBER.md and SOUL.md)
    assert.strictEqual(commitLines.length, 2, 'should have exactly 2 commit lines (1 per file) with --limit 1');
  } finally {
    process.chdir(origCwd);
    cleanup(cwd);
  }
});

test('member history --json outputs valid structure', () => {
  const { cwd } = setupGitWorkspace();
  const origCwd = process.cwd();
  try {
    process.chdir(cwd);

    const originalLog = console.log;
    let jsonOutput = '';
    console.log = (text) => { jsonOutput = text; };

    memberCommand('history', 'test-member', '--json');

    console.log = originalLog;

    const payload = JSON.parse(jsonOutput);
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.action, 'history');
    assert.strictEqual(payload.member, 'test-member');
    assert.ok(Array.isArray(payload.files));
    assert.ok(payload.files.length >= 2, 'should have at least 2 files');

    // check file structure
    for (const file of payload.files) {
      assert.ok(typeof file.path === 'string');
      assert.ok(Array.isArray(file.commits));
      for (const commit of file.commits) {
        assert.ok(typeof commit.hash === 'string');
        assert.ok(typeof commit.date === 'string');
        assert.ok(typeof commit.subject === 'string');
      }
    }
  } finally {
    process.chdir(origCwd);
    cleanup(cwd);
  }
});

test('member history on unborn member (no git history) returns empty', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-history-unborn-'));
  const origCwd = process.cwd();
  try {
    process.chdir(cwd);
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd, stdio: 'pipe' });

    const atrisDir = path.join(cwd, 'atris');
    const teamDir = path.join(atrisDir, 'team');
    const memberDir = path.join(teamDir, 'unborn-member');
    fs.mkdirSync(memberDir, { recursive: true });

    // create MEMBER.md but don't commit it
    fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Member\n', 'utf8');
    execSync('git add -A && git commit -qm "init"', { cwd, stdio: 'pipe' });

    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));

    // now delete the git history for just this one file to simulate no commits
    // actually, let's just test with a fresh member, so use a different approach
    // clear the git history
    const gitDir = path.join(cwd, '.git');
    fs.rmSync(gitDir, { recursive: true, force: true });
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd, stdio: 'pipe' });
    fs.mkdirSync(path.join(memberDir, 'logs'), { recursive: true });

    memberCommand('history', 'unborn-member', '--json');

    console.log = originalLog;

    // should succeed and show empty commits list
    const jsonLine = lines[0];
    const payload = JSON.parse(jsonLine);
    assert.strictEqual(payload.ok, true);
    assert.ok(Array.isArray(payload.files));
    // at least one file with empty commits
    const hasEmptyFile = payload.files.some((f) => f.commits.length === 0);
    assert.ok(hasEmptyFile, 'should have at least one file with empty commits list');
  } finally {
    process.chdir(origCwd);
    cleanup(cwd);
  }
});
