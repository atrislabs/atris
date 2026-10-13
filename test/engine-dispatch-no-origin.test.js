'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cliPath = path.resolve(__dirname, '../bin/atris.js');

// Like the one-lap runtime fixtures, a PATH stub replaces the real model.
for (const { yolo, origin } of [{ yolo: false }, { yolo: true }, { origin: true }]) {
  test(origin ? 'dispatch with an unavailable origin keeps the remote path' : `dispatch without origin preserves verified local work${yolo ? ' with yolo' : ''}`, () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-no-origin-')));
    const root = path.join(dir, 'repo with spaces');
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    for (const folder of [root, home, bin]) fs.mkdirSync(folder);
    const env = {
      HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      ATRIS_TEST_PROMPT: path.join(dir, 'prompt.txt'),
      ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_INTERACTIVE: '1', ATRIS_NONINTERACTIVE: '1',
    };
    function run(command, args, cwd = root) {
      const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60000 });
      assert.ifError(result.error);
      return result;
    }
    function git(args, cwd = root) {
      const result = run('git', args, cwd);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    function cli(args) { return run(process.execPath, [cliPath, ...args]); }
    try {
      git(['init', '-b', 'local-feature']);
      git(['config', 'user.name', 'local dispatch test']);
      git(['config', 'user.email', 'local@example.test']);
      fs.writeFileSync(path.join(root, 'result.txt'), 'before\n');
      fs.writeFileSync(path.join(root, 'check.test.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt', 'utf8'), 'after\\n');\n");
      git(['add', 'result.txt', 'check.test.cjs']);
      git(['commit', '-m', 'local starting point']);
      const initial = git(['rev-parse', 'HEAD']);
      // Another remote and stale origin refs must not count as an origin remote.
      if (yolo) {
        git(['remote', 'add', 'upstream', path.join(dir, 'unused.git')]);
        git(['update-ref', 'refs/remotes/origin/master', initial]);
        fs.writeFileSync(path.join(root, 'local-only.txt'), 'current local work\n');
        git(['add', 'local-only.txt']);
        git(['commit', '-m', 'later local work']);
      }
      if (origin) git(['remote', 'add', 'origin', path.join(dir, 'unused.git')]);
      const start = git(['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" > "$ATRIS_TEST_PROMPT"
printf 'after\\n' > result.txt
git add result.txt
git commit -m 'correct the local result'
printf 'saved the local result\\n'
`, { mode: 0o755 });
      // Ensure the optional scout cannot reach a real model from the inherited PATH.
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const initialized = cli(['init', '--minimal', '--yes']);
      assert.equal(initialized.status, 0, initialized.stderr);
      const created = cli(['task', 'new', 'Correct result.txt so the local result is right. Done: result is after. Check: node --test check.test.cjs.', '--tag', 'code']);
      assert.equal(created.status, 0, created.stderr);
      const id = created.stdout.match(/([A-Z][A-Z0-9]*-\d+)/)[1];
      const dispatched = cli(['engine', 'dispatch', id, '--engine', 'codex', ...(yolo ? ['--yolo'] : [])]);
      const runs = fs.readdirSync(path.join(root, 'atris', 'runs')).filter(name => /^dispatch-.*[.]json$/.test(name));
      assert.equal(runs.length, 1);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'runs', runs[0]), 'utf8'));
      if (origin) {
        assert.equal(dispatched.status, 1);
        assert.equal(receipt.paused[0].stage, 'worktree_start');
        assert.match(receipt.paused[0].detail, /invalid reference: origin\/HEAD/);
        assert.equal(receipt.paused[0].claim_released, true);
        assert.equal(receipt.local_only, undefined);
        assert.equal(fs.existsSync(env.ATRIS_TEST_PROMPT), false, 'the engine cannot start without the protected base');
        return;
      }
      assert.equal(dispatched.status, 0, JSON.stringify(receipt.paused));
      const prompt = fs.readFileSync(env.ATRIS_TEST_PROMPT, 'utf8');
      assert.doesNotMatch(prompt, /then land it yourself/);
      assert.match(prompt, /Do not push, merge/);
      assert.equal(receipt.ready.length, 1);
      assert.equal(receipt.landed.length, 0);
      assert.equal(receipt.paused.length, 0);
      const ready = receipt.ready[0];
      assert.equal(ready.review_recorded, true);
      assert.equal(ready.verifier_result.passed, true);
      assert.equal(receipt.result.passed, true);
      assert.equal(receipt.result.kind, 'dispatch_review_ready');
      assert.equal(receipt.local_only, true);
      assert.equal(git(['rev-parse', 'HEAD']), start, 'the launcher is left for the user to merge');
      assert.equal(git(['branch', '--show-current']), 'local-feature');
      assert.equal(git(['rev-parse', 'HEAD^'], ready.worktree), start, 'the build starts at the current local commit');
      assert.equal(fs.readFileSync(path.join(ready.worktree, 'result.txt'), 'utf8'), 'after\n');
      assert.match(ready.next_action, /git merge --ff-only/);
      assert.ok(dispatched.stdout.includes(ready.next_action), dispatched.stdout);
      const shown = cli(['task', 'show', id, '--json']);
      assert.equal(shown.status, 0, shown.stderr);
      assert.equal(JSON.parse(shown.stdout).status, 'review');
      const merged = run('sh', ['-c', ready.next_action]);
      assert.equal(merged.status, 0, merged.stderr);
      assert.equal(fs.readFileSync(path.join(root, 'result.txt'), 'utf8'), 'after\n');
      assert.equal(git(['remote']).split('\n').includes('origin'), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
