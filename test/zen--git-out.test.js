'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitOut } = require('../lib/zen');

function withGitDirectory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-git-out-'));
  const savedEnv = process.env;
  // Git inherits this environment, so ignore user config and repository overrides.
  // No ATRIS_* variables are passed through either.
  process.env = {
    PATH: savedEnv.PATH || '/usr/bin:/bin',
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'absent-config'),
    GIT_CEILING_DIRECTORIES: root,
  };
  try {
    run(root);
  } finally {
    process.env = savedEnv;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('gitOut returns the branch name from a real repository', () => {
  withGitDirectory((root) => {
    assert.strictEqual(gitOut(['init', '--quiet', '--bare', '--template=', root], root), '');
    assert.strictEqual(gitOut(['symbolic-ref', 'HEAD', 'refs/heads/fixture-branch'], root), '');
    assert.strictEqual(gitOut(['symbolic-ref', '--short', 'HEAD'], root), 'fixture-branch');
  });
});

test('gitOut trims outer whitespace while preserving internal whitespace', () => {
  withGitDirectory((root) => {
    const config = path.join(root, 'fixture.config');
    fs.writeFileSync(config, '[fixture]\nvalue = "  alpha  beta\\ngamma  "\n');
    assert.strictEqual(
      gitOut(['config', '--file', config, '--get', 'fixture.value'], root),
      'alpha  beta\ngamma'
    );
  });
});

test('gitOut distinguishes successful empty output from a failed command', () => {
  withGitDirectory((root) => {
    const config = path.join(root, 'fixture.config');
    fs.writeFileSync(config, '[fixture]\nempty = ""\n');
    assert.strictEqual(gitOut(['config', '--file', config, '--get', 'fixture.empty'], root), '');
    assert.strictEqual(gitOut(['config', '--file', config, '--get', 'fixture.missing'], root), null);
    assert.strictEqual(gitOut(['rev-parse', '--git-dir'], root), null);
  });
});
