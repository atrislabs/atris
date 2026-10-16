'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRunnerCommand, codexJsonEventsCommand } = require('../lib/runner-command');

function fixture(config, fn, template) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sandbox-'));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^ATRIS_(RUNNER|CLAUDE)_/.test(key)) delete process.env[key];
  }
  process.env.CODEX_HOME = home;
  process.env.ATRIS_RUNNER_PROFILE = 'codex';
  if (template) process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = template;
  if (config !== null) fs.writeFileSync(path.join(home, 'config.toml'), config);
  try { fn(home); } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const build = () => buildRunnerCommand({ promptFile: '/tmp/prompt.md' });
const flags = '--sandbox workspace-write -c sandbox_workspace_write.network_access=true';
test('absent config gives codex workers writable workspaces and network', () => {
  fixture(null, () => assert.ok(build().startsWith(`codex exec ${flags} `)));
});
test('top-level sandbox choices preserve the exact previous command', () => {
  for (const value of ['read-only', 'workspace-write', 'danger-full-access']) {
    fixture(`  sandbox_mode = "${value}"\n[profiles.x]\n`, () => {
      assert.equal(build(), 'codex exec "$(cat /tmp/prompt.md)"');
    });
  }
});
test('profile sandbox setting does not count as a top-level choice', () => {
  fixture('# sandbox_mode = "read-only"\n[profiles.x]\nsandbox_mode = "read-only"', () => assert.ok(build().includes(flags)));
});
test('explicit template permission flags win without duplicates', () => {
  for (const option of ['--sandbox read-only', '--sandbox=read-only', '-s read-only', '--full-auto', '--dangerously-bypass-approvals-and-sandbox']) {
    fixture(null, () => assert.equal(build(), `codex exec ${option} "$(cat /tmp/prompt.md)"`), `{bin} exec ${option} {prompt}`);
    fixture(null, () => assert.equal(build(), `codex exec "$(cat /tmp/prompt.md)" ${option}`), `{bin} exec {prompt} ${option}`);
  }
});
test('HOME fallback and unreadable config are handled', () => {
  fixture(null, (home) => {
    delete process.env.CODEX_HOME;
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex/config.toml'), 'sandbox_mode = "read-only"');
    assert.equal(build(), 'codex exec "$(cat /tmp/prompt.md)"');
    fs.rmSync(path.join(home, '.codex/config.toml'));
    fs.mkdirSync(path.join(home, '.codex/config.toml'));
    assert.ok(build().includes(flags));
  });
});
test('JSON events variant preserves sandbox flags', () => {
  fixture(null, (home) => {
    const bin = path.join(home, 'codex');
    fs.writeFileSync(bin, '#!/bin/sh\necho "--json --output-last-message"\n', { mode: 0o700 });
    process.env.ATRIS_RUNNER_BIN = bin;
    const cmd = codexJsonEventsCommand(build(), '/tmp/last.txt');
    assert.ok(cmd.includes(flags));
    assert.equal(cmd.split('--sandbox').length, 2);
  });
});
