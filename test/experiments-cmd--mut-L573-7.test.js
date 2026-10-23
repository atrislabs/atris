const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('dry run preserves the repository revision in the saved receipt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-receipt-revision-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  t.after(() => {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });
  process.env.HOME = root;
  process.chdir(root);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Receipt Test',
    GIT_AUTHOR_EMAIL: 'receipt@example.invalid',
    GIT_COMMITTER_NAME: 'Receipt Test',
    GIT_COMMITTER_EMAIL: 'receipt@example.invalid',
    GIT_AUTHOR_DATE: '2024-01-15T12:00:00Z',
    GIT_COMMITTER_DATE: '2024-01-15T12:00:00Z',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'no-git-config'),
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const pack = path.join(root, 'atris', 'experiments', 'endstate-baseline');
  const contract = path.join(root, 'atris', 'features', 'endstate');
  fs.mkdirSync(pack, { recursive: true });
  fs.mkdirSync(contract, { recursive: true });
  fs.writeFileSync(path.join(pack, 'program.md'), '# Program\nCheck the repository revision.\n');
  fs.writeFileSync(path.join(contract, 'contract.md'), '# Contract\n');
  fs.writeFileSync(path.join(contract, 'artifact-schema.json'), '{}\n');
  const { experimentsCommand } = require('../commands/experiments');
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
  t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit ${code}`); });

  experimentsCommand('run', 'endstate-baseline', '--dry-run', '--backend', root);

  const artifacts = path.join(pack, 'artifacts');
  const receipt = JSON.parse(fs.readFileSync(path.join(artifacts, fs.readdirSync(artifacts)[0]), 'utf8'));
  assert.strictEqual(receipt.repo_commits_after.atris_cli, revision);
});
