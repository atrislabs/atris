const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { reviewOnlyEngineEnvironment } = require('../lib/fleet');

// reviewOnlyEngineEnvironment refuses to build an environment without the
// macOS sandbox-exec isolation backend, so this guarantee is only testable
// on darwin. Linux CI skips it rather than reporting a false failure.
test('claude flights never receive an api key, even when the parent env has one', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-env-test-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git remote add origin https://example.invalid/repo.git', { cwd: worktree });
  const hadKey = process.env.ANTHROPIC_API_KEY;
  const hadToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'sk-test-should-never-pass-through';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'subscription-token';
  try {
    const env = reviewOnlyEngineEnvironment(worktree, { engine: 'claude' });
    assert.strictEqual(env.ANTHROPIC_API_KEY, '', 'api key must be stripped: subscription only');
    assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-token', 'subscription token passes through');
  } finally {
    if (hadKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = hadKey;
    if (hadToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = hadToken;
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});
