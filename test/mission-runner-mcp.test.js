const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeRunnerMcpArgs } = require('../commands/mission');

test('code members start without account-wide tool servers but keep the project ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runner-mcp-'));
  try {
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'executor' }, dir, {}), ['--strict-mcp-config']);
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{}}');
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'navigator' }, dir, {}), ['--strict-mcp-config', '--mcp-config', path.join(dir, '.mcp.json')]);
    // Members whose work may use mail or calendar keep everything.
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'inbox-lead' }, dir, {}), []);
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'customer-lead' }, dir, {}), []);
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'executor' }, dir, { ATRIS_MEMBER_KEEP_MCP: '1' }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('servers added for this folder in claude local scope still load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runner-mcp-local-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runner-mcp-home-'));
  try {
    const servers = { browser: { command: 'npx', args: ['browser-mcp'] } };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [path.resolve(dir)]: { mcpServers: servers } } }));
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'validator' }, dir, { HOME: home }),
      ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: servers })]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a worker that edits what the test command runs is caught, adding other files is not', () => {
  const { tickTouchedCheckDefinition } = require('../commands/mission');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-edited-'));
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"node --test checks/a.js"}}');
    fs.mkdirSync(path.join(dir, 'checks'));
    fs.writeFileSync(path.join(dir, 'checks', 'a.js'), '');
    fs.writeFileSync(path.join(dir, 'app.js'), 'old');
    git('add', '-A'); git('commit', '-qm', 'seed');
    const before = { head: git('rev-parse', 'HEAD').stdout.trim() };
    fs.writeFileSync(path.join(dir, 'app.js'), 'new');
    assert.equal(tickTouchedCheckDefinition('npm test', before, dir), false);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"true"}}');
    assert.equal(tickTouchedCheckDefinition('npm test', before, dir), true);
    git('checkout', '--', 'package.json');
    fs.writeFileSync(path.join(dir, 'checks', 'a.js'), '// emptied');
    git('commit', '-qam', 'worker commit');
    assert.equal(tickTouchedCheckDefinition('node --test checks/a.js', before, dir), true);
    // Second round: npm test runs package.json's script, so its test files count,
    // and with no starting commit every tracked file counts.
    assert.equal(tickTouchedCheckDefinition('npm test', before, dir), true);
    assert.equal(tickTouchedCheckDefinition('npm test', { head: null }, dir), true);
    // Third round: auto-discovered tests are never named, so test-shaped files count.
    const head2 = git('rev-parse', 'HEAD').stdout.trim();
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'test', 'b.test.js'), '// weakened');
    assert.equal(tickTouchedCheckDefinition('node --test', { head: head2 }, dir), true);
    fs.rmSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.js'), 'newer');
    assert.equal(tickTouchedCheckDefinition('node --test', { head: head2 }, dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the learned line from a receipt reaches the member log', () => {
  const { receiptLearnedLine } = require('../commands/mission');
  assert.equal(receiptLearnedLine('Fixed parser.\nlearned: use UTC for dates\nnext_push: x'), 'use UTC for dates');
  assert.equal(receiptLearnedLine('- learned: keep it small'), 'keep it small');
  assert.equal(receiptLearnedLine('Fixed parser.'), undefined);
  assert.equal(receiptLearnedLine(`${'x'.repeat(4100)}\nlearned: use UTC`), 'use UTC');
});

test('a side checkout keeps tool servers registered for its main checkout', () => {
  const { spawnSync } = require('node:child_process');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runner-mcp-wt-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runner-mcp-home-'));
  const main = fs.realpathSync(base) + '/main';
  const side = fs.realpathSync(base) + '/side';
  const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  try {
    fs.mkdirSync(main);
    git(main, 'init', '-q'); git(main, 'commit', '-q', '--allow-empty', '-m', 'seed');
    git(main, 'worktree', 'add', '-q', '-b', 'side', side);
    const servers = { browser: { command: 'npx', args: ['browser-mcp'] } };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [main]: { mcpServers: servers } } }));
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'executor' }, side, { HOME: home }),
      ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: servers })]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
