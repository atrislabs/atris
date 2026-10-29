'use strict';

// On 2026-10-28 unattended jobs ran Opus and Fable in loops and billed about
// $900 of paid Claude usage in one day. These cases pin the guard's rule:
// Haiku free, anything else unattended needs a named yes, no pay-per-use key.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../lib/claude-spend-guard');

function tempHome(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-guard-'));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  return dir;
}

const quiet = (env) => ({ HOME: tempHome(), ...env });

test('haiku runs free', () => {
  const r = guard.checkClaudeSpend({ model: 'claude-haiku-5-5', env: quiet({}) });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'free_model');
});

test('opus, fable and sonnet are blocked without a yes', () => {
  for (const model of ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'opus', 'opus[1m]']) {
    const r = guard.checkClaudeSpend({ model, job: 'bench', env: quiet({}) });
    assert.equal(r.ok, false, model);
    assert.equal(r.reason, 'paid_model');
    assert.match(r.message, /ATRIS_CLAUDE_SPEND_OK=/);
  }
});

test('a yes names the exact model, nothing broader', () => {
  const env = quiet({ ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' });
  assert.equal(guard.checkClaudeSpend({ model: 'claude-opus-5-5', env }).ok, true);
  assert.equal(guard.checkClaudeSpend({ model: 'claude-fable-5-1', env }).ok, false);
});

test('approved runs are written to the ledger', () => {
  const env = quiet({ ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' });
  guard.checkClaudeSpend({ model: 'claude-opus-5-5', job: 'bench', env });
  const rows = fs.readFileSync(guard.ledgerPath(env), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].decision, 'approved');
  assert.equal(rows[0].job, 'bench');
});

test('no --model means the settings default, which is Opus here', () => {
  const env = { HOME: tempHome({ model: 'opus[1m]' }) };
  const r = guard.checkClaudeSpend({ model: '', env });
  assert.equal(r.ok, false);
  assert.equal(r.model, 'opus[1m]');
});

test('no --model and no settings means the account default, treated as paid', () => {
  const r = guard.checkClaudeSpend({ model: '', env: { HOME: tempHome() } });
  assert.equal(r.ok, false);
  assert.equal(r.model, 'default');
});

test('a haiku alias remapped to Opus is judged as Opus', () => {
  const env = quiet({ ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-5-5' });
  assert.equal(guard.checkClaudeSpend({ model: 'haiku', env }).ok, false);
});

test('the key check blocks a pay-per-use key even on haiku', () => {
  const env = quiet({ ANTHROPIC_API_KEY: 'sk-ant-test' });
  const r = guard.checkClaudeSpend({ model: 'claude-haiku-5-5', env, checkKey: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'paid_key');
  assert.doesNotMatch(r.message, /sk-ant-test/);
});

test('child env drops the pay-per-use key unless a server opts in', () => {
  const env = { ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', PATH: '/bin' };
  const child = guard.claudeChildEnv(env);
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(child.PATH, '/bin');
  assert.equal(env.ANTHROPIC_API_KEY, 'a', 'input env is not mutated');
  assert.equal(guard.claudeChildEnv({ ...env, ATRIS_CLAUDE_KEY_OK: '1' }).ANTHROPIC_API_KEY, 'a');
});

test('hook: a person in an interactive session is never blocked', () => {
  const env = quiet({ CLAUDE_CODE_ENTRYPOINT: 'cli' });
  const d = guard.hookDecision({ argv: ['claude', '--model', 'claude-opus-5-5'], env });
  assert.equal(d.block, false);
});

test('hook: headless Opus is blocked, headless Haiku runs', () => {
  const env = quiet({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  assert.equal(guard.hookDecision({ argv: ['claude', '-p', '--model', 'claude-opus-5-5', 'hi'], env }).block, true);
  assert.equal(guard.hookDecision({ argv: ['claude', '-p', '--model=claude-haiku-5-5', 'hi'], env }).block, false);
});

test('hook: SDK runs count as unattended without -p', () => {
  const env = quiet({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' });
  assert.equal(guard.hookDecision({ argv: ['claude', '--output-format', 'stream-json', '--model', 'opus'], env }).block, true);
});

test('hook: headless run carrying a pay-per-use key is blocked', () => {
  const env = quiet({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', ANTHROPIC_API_KEY: 'sk-ant-test' });
  assert.equal(guard.hookDecision({ argv: ['claude', '-p', '--model', 'haiku'], env }).block, true);
});

test('hook: not under claude means no decision', () => {
  assert.equal(guard.hookDecision({ argv: null, env: quiet({}) }).block, false);
});

test('install keeps existing hooks, puts the guard first, and is idempotent', () => {
  const home = tempHome({
    model: 'opus[1m]',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node voice-card.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node voice-gate.js' }] }] },
  });
  const env = { HOME: home };
  guard.installGuard({ env });
  const status = guard.installGuard({ env });
  assert.equal(status.installed, true);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const ups = settings.hooks.UserPromptSubmit;
  assert.equal(ups.length, 2);
  assert.match(ups[0].hooks[0].command, /claude-spend-guard\.js$/);
  assert.equal(ups[1].hooks[0].command, 'node voice-card.js');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'node voice-gate.js');
  assert.equal(settings.model, 'opus[1m]');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'hooks', 'claude-spend-guard.js')));

  const after = guard.uninstallGuard({ env });
  assert.equal(after.installed, false);
  const restored = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(restored.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'node voice-card.js' }] }]);
});

test('install refuses to overwrite settings it cannot parse', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
  assert.throws(() => guard.installGuard({ env: { HOME: home } }));
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{ not json');
});
