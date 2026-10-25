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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the learned line from a receipt reaches the member log', () => {
  const { receiptLearnedLine } = require('../commands/mission');
  assert.equal(receiptLearnedLine('Fixed parser.\nlearned: use UTC for dates\nnext_push: x'), 'use UTC for dates');
  assert.equal(receiptLearnedLine('- learned: keep it small'), 'keep it small');
  assert.equal(receiptLearnedLine('Fixed parser.'), undefined);
});
