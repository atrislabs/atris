const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scanFile, applyFixes, loadProjectRules, addProjectRule, gitChangedLines, installHook, RULES } = require('../commands/slop');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sloploop-')); }

test('--fix repairs em dashes in place and leaves a comma', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'copy.md');
  fs.writeFileSync(f, 'Fast, reliable — and calm.\nShip it — today.\n');
  const { fixedCount, fixedFiles } = applyFixes([f], RULES);
  assert.ok(fixedCount >= 2);
  assert.deepEqual(fixedFiles, [f]);
  const after = fs.readFileSync(f, 'utf8');
  assert.ok(!after.includes('—'), 'em dash should be gone');
  assert.match(after, /Fast, reliable, and calm\./);
  // re-scan is clean for em-dash
  assert.equal(scanFile(f).filter((x) => x.rule === 'em-dash').length, 0);
});

test('--fix never touches tells that need judgment (gradient text stays)', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'Hero.tsx');
  fs.writeFileSync(f, '<h1 className="text-transparent bg-clip-text">hi</h1>\n');
  const before = fs.readFileSync(f, 'utf8');
  applyFixes([f], RULES);
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'unsafe tells are not auto-edited');
});

test('project rules from .atris/slop.rules.json load and fire', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'slop.rules.json'),
    JSON.stringify([{ id: 'no-foobar', pattern: 'foobar', why: 'banned word', sev: 'error' }]));
  const rules = RULES.concat(loadProjectRules(dir));
  const f = path.join(dir, 'note.md');
  fs.writeFileSync(f, 'this mentions foobar once\n');
  const hits = scanFile(f, rules).map((x) => x.rule);
  assert.ok(hits.includes('no-foobar'));
});

test('addProjectRule writes and dedups by id', () => {
  const dir = tmpDir();
  addProjectRule({ id: 'r1', pattern: 'aaa', why: 'first', sev: 'warn' }, dir);
  addProjectRule({ id: 'r1', pattern: 'bbb', why: 'updated', sev: 'error' }, dir);
  addProjectRule({ id: 'r2', pattern: 'ccc', why: 'second', sev: 'warn' }, dir);
  const loaded = loadProjectRules(dir);
  assert.equal(loaded.length, 2);
  const r1 = loaded.find((r) => r.id === 'r1');
  assert.equal(r1.sev, 'error');
  assert.ok(r1.re.test('bbb'));
});

test('a malformed project rule is skipped, not fatal', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'slop.rules.json'),
    JSON.stringify([{ id: 'bad', pattern: '(' }, { id: 'good', pattern: 'ok' }]));
  const loaded = loadProjectRules(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'good');
});

test('installHook writes an executable pre-commit gate, idempotently', () => {
  const dir = tmpDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const r1 = installHook(dir);
  assert.equal(r1.already, false);
  const hook = fs.readFileSync(r1.hookPath, 'utf8');
  assert.match(hook, /atris slop detect --staged/);
  assert.match(hook, /# atris slop gate/);
  assert.ok((fs.statSync(r1.hookPath).mode & 0o111) !== 0, 'hook should be executable');
  // second call is a no-op (idempotent), not a duplicate block
  const r2 = installHook(dir);
  assert.equal(r2.already, true);
  const occurrences = fs.readFileSync(r1.hookPath, 'utf8').split('# atris slop gate').length - 1;
  assert.equal(occurrences, 1);
});

test('installHook refuses a non-git directory', () => {
  assert.throws(() => installHook(tmpDir()), /not a git repo/);
});

test('--diff scopes findings to changed lines only', () => {
  const dir = tmpDir();
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 't');
  const f = path.join(dir, 'doc.md');
  // committed line already has an em dash; it must NOT be reported by --diff
  fs.writeFileSync(f, 'old line with an em dash —\nsecond line clean\n');
  git('add', '.'); git('commit', '-qm', 'base');
  // add a NEW line with an em dash
  fs.writeFileSync(f, 'old line with an em dash —\nsecond line clean\nnew line also — slop\n');
  const changed = gitChangedLines(false, dir);
  const abs = path.resolve(dir, 'doc.md');
  assert.ok(changed.has(abs));
  assert.ok(changed.get(abs).has(3), 'line 3 is the changed line');
  assert.ok(!changed.get(abs).has(1), 'line 1 was not changed');
});
