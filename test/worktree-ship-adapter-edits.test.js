const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { upsertAtrisClaudeBootBlock } = require('../lib/claude-boot-block');
const { upsertAgentVoiceCard, renderVoiceCardBlock } = require('../lib/voice-card');
const { upsertAgentsOpeningLines } = require('../lib/opening-lines');

const cli = path.resolve(__dirname, '../bin/atris.js');
const bootStart = '<!-- ATRIS:START - Auto-generated, do not edit -->';
const bootEnd = '<!-- ATRIS:END -->';
const brainStart = '<!-- ATRIS_BRAIN_COMPILE:START -->';
const brainEnd = '<!-- ATRIS_BRAIN_COMPILE:END -->';
const baseline = `# Personal instructions\nkeep this\n${bootStart}\nold boot\n${bootEnd}\n\n${brainStart}\n## Atris Brain Compile\n\nLoad these first:\n- atris/now.md\n\nRe-run after meaningful work:\n\`atris brain compile --root .\`\n${brainEnd}\n`;

function fixture(t, content = baseline, { autocrlf = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-adapter-edits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const work = path.join(dir, 'work');
  const remote = path.join(dir, 'remote.git');
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  git(['init', '--bare', '-q', remote]);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) fs.writeFileSync(path.join(repo, file), content);
  fs.mkdirSync(path.join(repo, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.atris', 'state', 'tasks.projection.json'), '{"old":true}\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'original\n');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  git(['branch', '-M', 'master']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'master']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  if (autocrlf) git(['config', 'core.autocrlf', 'true']);
  git(['worktree', 'add', '-qb', 'test-adapter', work, 'master']);
  const ship = (extra = [], message = 'save changes') => spawnSync(process.execPath, [cli, 'worktree', 'ship', '--message', message, '--no-pr', '--no-map-refresh', ...extra], {
    cwd: work, encoding: 'utf8', timeout: 20000, env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  return { work, git, ship };
}

test('ship discards the real first boot block and its separator', (t) => {
  const original = '# Personal instructions\nkeep this\n';
  const { work, git, ship } = fixture(t, original);
  const file = path.join(work, 'CLAUDE.md');
  fs.writeFileSync(file, upsertAtrisClaudeBootBlock(fs.readFileSync(file, 'utf8'), { openingLines: ['review opening'] }).content);
  fs.writeFileSync(path.join(work, 'README.md'), 'real change\n');
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skipped regenerated adapter churn: CLAUDE\.md/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(git(['show', '--name-only', '--format=', 'HEAD'], work).trim(), 'README.md');
});

test('ship discards the real voice writer brain block and separator', (t) => {
  const original = '# Personal instructions\nkeep this\n';
  const { work, git, ship } = fixture(t, original);
  const file = path.join(work, 'AGENTS.md');
  upsertAgentVoiceCard(file, 'review voice');
  fs.writeFileSync(path.join(work, 'README.md'), 'real change\n');
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skipped regenerated adapter churn: AGENTS\.md/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(git(['show', '--name-only', '--format=', 'HEAD'], work).trim(), 'README.md');
});

test('ship discards the real voice rewrite with Git Windows checkout line endings', (t) => {
  const { work, git, ship } = fixture(t, baseline, { autocrlf: true });
  const file = path.join(work, 'AGENTS.md');
  assert.match(fs.readFileSync(file, 'utf8'), /\r\n/);
  assert.doesNotMatch(git(['show', ':AGENTS.md'], work), /\r\n/);
  upsertAgentVoiceCard(file, 'new real voice');
  fs.writeFileSync(path.join(work, 'README.md'), 'real change\n');
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skipped regenerated adapter churn: AGENTS\.md/);
  assert.equal(git(['show', 'HEAD:AGENTS.md'], work), baseline);
  assert.equal(git(['show', '--name-only', '--format=', 'HEAD'], work).trim(), 'README.md');
});

test('ship keeps a real hand edit next to a real generated block', (t) => {
  const original = '# Personal instructions\nkeep this\n';
  const { work, git, ship } = fixture(t, original);
  const file = path.join(work, 'CLAUDE.md');
  const generated = upsertAtrisClaudeBootBlock(original, { openingLines: ['review opening'] }).content;
  const changed = generated.replace('keep this', 'keep this hand edit');
  fs.writeFileSync(file, changed);
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /kept hand edits in CLAUDE\.md/);
  assert.equal(git(['show', 'HEAD:CLAUDE.md'], work), changed);
});

test('ship discards the real operating rules block', (t) => {
  const original = '# Personal instructions\nkeep this\n';
  const { work, git, ship } = fixture(t, original);
  const file = path.join(work, 'AGENTS.md');
  upsertAgentsOpeningLines(file, '- **Care.** Keep it simple.');
  fs.writeFileSync(path.join(work, 'README.md'), 'real change\n');
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skipped regenerated adapter churn: AGENTS\.md/);
  assert.equal(git(['show', 'HEAD:AGENTS.md'], work), original);
});

test('ship discards standalone voice and mission signal changes', (t) => {
  const signalStart = '<!-- ATRIS_MISSION_ROOM_SIGNALS:START -->';
  const signalEnd = '<!-- ATRIS_MISSION_ROOM_SIGNALS:END -->';
  const original = `# Personal instructions\n${renderVoiceCardBlock('old voice')}\n${signalStart}\nold signal\n${signalEnd}\n`;
  const { work, git, ship } = fixture(t, original);
  fs.writeFileSync(path.join(work, 'GEMINI.md'), original.replace('old voice', 'new voice').replace('old signal', 'new signal'));
  fs.writeFileSync(path.join(work, 'README.md'), 'real change\n');
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skipped regenerated adapter churn: GEMINI\.md/);
  assert.equal(git(['show', 'HEAD:GEMINI.md'], work), original);
});

test('ship discards a line-ending-only edit', (t) => {
  const original = '# Personal instructions\nkeep this\n';
  const { work, git, ship } = fixture(t, original);
  fs.writeFileSync(path.join(work, 'GEMINI.md'), original.replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(work, 'README.md'), 'real change\n');
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skipped regenerated adapter churn: GEMINI\.md/);
  assert.equal(git(['show', 'HEAD:GEMINI.md'], work), original);
});

test('ship keeps a second extra blank line next to a generated block', (t) => {
  const original = '# Personal instructions\nkeep this\n';
  const { work, git, ship } = fixture(t, original);
  const changed = `${brainStart}\nfirst compile\n${brainEnd}\n\n\n${original}`;
  fs.writeFileSync(path.join(work, 'AGENTS.md'), changed);
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /kept hand edits in AGENTS\.md/);
  assert.equal(git(['show', 'HEAD:AGENTS.md'], work), changed);
});

for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
  for (const fail of [false, true]) {
    test(`ship preserves hand edits to ${file}${fail ? ' when verification fails' : ''}`, (t) => {
      const { work, git, ship } = fixture(t);
      const edited = `${baseline}a person's instruction\n`;
      fs.writeFileSync(path.join(work, file), edited);
      const result = ship(fail ? ['--verify', `${process.execPath} -e "process.exit(1)"`] : []);
      assert.equal(result.status, fail ? 1 : 0, result.stderr || result.stdout);
      assert.match(result.stdout, new RegExp(`ship: kept hand edits in ${file.replace('.', '\\.')}`));
      assert.equal(fs.readFileSync(path.join(work, file), 'utf8'), edited);
      assert.equal(git(['show', `HEAD:${file}`], work), edited);
    });
  }
}

test('ship discards only generated command changes inside the brain block', (t) => {
  const { work, git, ship } = fixture(t);
  const changed = baseline.replace('`atris brain compile --root .`', '`atris brain activate --root . --verify`\n`atris brain compile --root . --changed`');
  fs.writeFileSync(path.join(work, 'AGENTS.md'), changed);
  fs.writeFileSync(path.join(work, 'README.md'), 'real change\n');
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skipped regenerated adapter churn: AGENTS\.md/);
  assert.equal(fs.readFileSync(path.join(work, 'AGENTS.md'), 'utf8'), baseline);
  assert.equal(git(['show', '--name-only', '--format=', 'HEAD'], work).trim(), 'README.md');
});

test('ship discards complete generated blocks added to a marker-free file', (t) => {
  const original = '# Personal instructions\nkeep this\n';
  const { work, git, ship } = fixture(t, original);
  const generated = `${bootStart}\nfirst boot\n${bootEnd}\n${brainStart}\nfirst compile\n${brainEnd}\n`;
  fs.writeFileSync(path.join(work, 'AGENTS.md'), generated + original);
  fs.writeFileSync(path.join(work, 'README.md'), 'real change\n');
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skipped regenerated adapter churn: AGENTS\.md/);
  assert.equal(fs.readFileSync(path.join(work, 'AGENTS.md'), 'utf8'), original);
  assert.equal(git(['show', '--name-only', '--format=', 'HEAD'], work).trim(), 'README.md');
});

test('ship keeps an added generated block together with a hand edit', (t) => {
  const original = '# Personal instructions\nkeep this\n';
  const { work, git, ship } = fixture(t, original);
  const changed = `${brainStart}\nfirst compile\n${brainEnd}\n${original}hand edit\n`;
  fs.writeFileSync(path.join(work, 'CLAUDE.md'), changed);
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /kept hand edits in CLAUDE\.md/);
  assert.equal(git(['show', 'HEAD:CLAUDE.md'], work), changed);
});

test('ship keeps a hand edit when neither version has generated blocks', (t) => {
  const original = '# Personal instructions\nkeep this\n';
  const { work, git, ship } = fixture(t, original);
  const changed = `${original}hand edit\n`;
  fs.writeFileSync(path.join(work, 'GEMINI.md'), changed);
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /kept hand edits in GEMINI\.md/);
  assert.equal(git(['show', 'HEAD:GEMINI.md'], work), changed);
});

test('ship keeps the whole file when generated churn and a hand edit are mixed', (t) => {
  const { work, git, ship } = fixture(t);
  const changed = baseline.replace('old boot', 'new boot').replace('keep this', 'keep this hand edit');
  fs.writeFileSync(path.join(work, 'CLAUDE.md'), changed);
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /kept hand edits in CLAUDE\.md/);
  assert.equal(git(['show', 'HEAD:CLAUDE.md'], work), changed);
});

for (const [label, before, after] of [
  ['missing', 'personal text\n', 'personal changed\n'],
  ['unpaired start', `${brainStart}\nold\n`, `${brainStart}\nnew\n`],
  ['unpaired end', `old\n${brainEnd}\n`, `new\n${brainEnd}\n`],
  ['removed marker', baseline, baseline.replace(brainEnd, '')],
  ['nested markers', `${brainStart}\n${brainStart}\nold\n${brainEnd}\n${brainEnd}\n`, `${brainStart}\n${brainStart}\nnew\n${brainEnd}\n${brainEnd}\n`],
  ['marker-like text', '<!-- ATRIS:START fake -->\nold\n<!-- ATRIS:END -->\n', '<!-- ATRIS:START fake -->\nnew\n<!-- ATRIS:END -->\n'],
]) {
  test(`ship preserves edits with ${label} markers`, (t) => {
    const { work, git, ship } = fixture(t, before);
    fs.writeFileSync(path.join(work, 'GEMINI.md'), after);
    const result = ship();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /kept hand edits in GEMINI\.md/);
    assert.equal(git(['show', 'HEAD:GEMINI.md'], work), after);
  });
}

test('ship handles Windows line endings for generated and hand edits', (t) => {
  const windows = baseline.replace(/\n/g, '\r\n');
  const { work, git, ship } = fixture(t, windows);
  fs.writeFileSync(path.join(work, 'AGENTS.md'), windows.replace('old boot', 'new boot'));
  const hand = windows.replace('keep this', 'keep this hand edit').replace('old boot', 'new boot');
  fs.writeFileSync(path.join(work, 'CLAUDE.md'), hand);
  const result = ship();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /skipped regenerated adapter churn: AGENTS\.md/);
  assert.match(result.stdout, /kept hand edits in CLAUDE\.md/);
  assert.equal(fs.readFileSync(path.join(work, 'AGENTS.md'), 'utf8'), windows);
  assert.equal(git(['show', 'HEAD:CLAUDE.md'], work), hand);
});

test('staging or naming a generated file preserves it, while projection churn is still discarded', (t) => {
  const { work, git, ship } = fixture(t);
  const changed = baseline.replace('old boot', 'new boot');
  for (const file of ['AGENTS.md', 'CLAUDE.md']) fs.writeFileSync(path.join(work, file), changed);
  git(['add', 'AGENTS.md'], work);
  fs.writeFileSync(path.join(work, '.atris', 'state', 'tasks.projection.json'), '{"new":true}\n');
  const result = ship([], 'update CLAUDE.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const file of ['AGENTS.md', 'CLAUDE.md']) assert.equal(git(['show', `HEAD:${file}`], work), changed);
  assert.equal(fs.readFileSync(path.join(work, '.atris', 'state', 'tasks.projection.json'), 'utf8'), '{"old":true}\n');
});
