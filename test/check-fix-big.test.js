'use strict';

// A big bug gets the strongest model: atris check fix adds --think, starts the
// task with "big bug" and posts one plain line to the owner notice channel.
// Nothing here reaches the cloud or the feed: a fake atris stands in for
// `computer pr` and the poster is stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkCommand, bigVerdict, bigNoticeLine } = require('../commands/check');
const { validateMap, lintMap } = require('../lib/check-plan');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

const MAP = {
  checks: {
    feature: { run: 'node fail.js', when: ['src/**'] },
    full: { run: 'node ok.js' },
  },
  risk: { high: { 'sign-in': ['src/auth/**'] } },
  gates: { release: ['full'] },
  default: ['full'],
};

async function failedProject(t, { map = MAP, file = 'src/feature.js' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fix-big-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const root = path.join(dir, 'work');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=master', remote);
  git(dir, 'init', '--quiet', '--initial-branch=master', root);
  for (const [key, value] of [['user.email', 'check@example.test'], ['user.name', 'check test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(root, 'config', key, value);
  git(root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(root, 'config', `url.${remote}.insteadOf`, 'https://github.com/acme/app.git');
  write(root, 'ok.js', 'process.exit(0);\n');
  write(root, 'fail.js', "console.log('broken'); process.exit(1);\n");
  write(root, file, 'module.exports = 1;\n');
  write(root, 'atris/checks.json', JSON.stringify(map, null, 2));
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
  git(root, 'push', '--quiet', 'origin', 'master');
  git(root, 'remote', 'set-head', 'origin', 'master');
  git(root, 'switch', '--quiet', '-c', 'feature');
  write(root, file, 'module.exports = 2;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'change\n\nProof: node ok.js');
  const bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'atris-calls.log');
  fs.writeFileSync(path.join(bin, 'atris'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(calls)}\necho COMMIT=abc123 PUSHED=fix-branch\n`);
  fs.chmodSync(path.join(bin, 'atris'), 0o755);
  const run = async (args, context = {}) => {
    const lines = [];
    const saved = { PATH: process.env.PATH, ATRIS_CHECK_PERSON: process.env.ATRIS_CHECK_PERSON };
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
    process.env.ATRIS_CHECK_PERSON = '1';
    try {
      const code = await checkCommand(args, { cwd: root, log: (line) => lines.push(String(line)), ...context });
      return { code, out: lines.join('\n') };
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  };
  assert.equal((await run([])).code, 1, 'the change fails its check');
  return { root, calls, run };
}

test('the big rule: high risk, or a failed check on a path in the map\'s big list; nothing else', () => {
  const failed = { checks: [{ name: 'tests', status: 'failed', exit_code: 1 }], changed_files: ['src/pay/charge.js'], risk_tier: 'normal', repo: 'app' };
  assert.deepEqual(bigVerdict({ ...failed, risk_tier: 'high', high_risk: ['money'] }, null), { big: true, why: 'high risk (money)' });
  assert.equal(bigVerdict(failed, validateMap({ checks: { a: { run: 'x' } }, big: ['src/pay/**'] })).big, true);
  assert.equal(bigVerdict(failed, validateMap({ checks: { a: { run: 'x' } } })).big, false, 'no big list, no default');
  assert.equal(bigVerdict({ ...failed, checks: [{ name: 'tests', status: 'passed' }] }, validateMap({ checks: { a: { run: 'x' } }, big: ['src/pay/**'] })).big, false, 'nothing failed');
  assert.equal(bigNoticeLine(failed), 'Big bug in app: tests failed on exit 1. A fix job is running with the strongest model.');
});

test('--lint-map takes big as a list of globs and owner_notice as feed or none, and refuses other shapes', () => {
  assert.deepEqual(lintMap({ checks: { a: { run: 'x' } }, big: ['src/auth/**'], owner_notice: 'none' }).errors, []);
  assert.match(lintMap({ checks: { a: { run: 'x' } }, big: 'src/auth/**' }).errors.join('\n'), /big must be a list of path globs/);
  assert.match(lintMap({ checks: { a: { run: 'x' } }, big: [3] }).errors.join('\n'), /big must be a list of path globs/);
  assert.match(lintMap({ checks: { a: { run: 'x' } }, owner_notice: 'text' }).errors.join('\n'), /owner_notice is "feed"/);
});

test('fix --dry-run on a big bug prints the verdict, the argv with --think and the notice, and sends nothing', async (t) => {
  const { calls, run } = await failedProject(t, { file: 'src/auth/session.js' });
  const posted = [];
  const result = await run(['fix', '--dry-run'], { postNotice: (line) => { posted.push(line); return { status: 0 }; } });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /^big: yes \(high risk \(sign-in\)\)$/m);
  assert.match(result.out, /^\)"; atris computer pr acme\/app "\$TASK" --business atris-codeops --base feature --think$/m);
  assert.match(result.out, /^big bug: Repo acme\/app/m);
  assert.match(result.out, /^notice: to the feed, once the job is sent: atris feed post 'Big bug in work: feature failed on exit 1\. A fix job is running with the strongest model\.'$/m);
  assert.match(result.out, /dry run: nothing was sent/);
  assert.equal(fs.existsSync(calls), false);
  assert.deepEqual(posted, []);
});

test('fix on a big bug sends --think, records big in the receipt, and posts one line; a failed post never fails the hand-off', async (t) => {
  const map = { ...MAP, big: ['src/pay/**'] };
  const { root, calls, run } = await failedProject(t, { map, file: 'src/pay/charge.js' });
  const result = await run(['fix'], { postNotice: () => { throw new Error('the feed is down'); } });
  assert.equal(result.code, 0, result.out);
  const args = fs.readFileSync(calls, 'utf8').split('\n');
  assert.ok(args.includes('--think'));
  assert.ok(args.some((line) => line.startsWith('big bug: ')));
  assert.match(result.out, /notice: not posted \(the feed is down\); the fix job was still sent/);
  const dir = path.join(root, '.atris', 'receipts');
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((name) => name.startsWith('check-'))), 'utf8'));
  assert.deepEqual(receipt.fix_big, { big: true, why: 'src/pay/charge.js matches the map\'s big list' });
});

test('owner_notice none posts nothing, and a plain failure is not big and gets no --think', async (t) => {
  const quiet = await failedProject(t, { map: { ...MAP, owner_notice: 'none' }, file: 'src/auth/session.js' });
  const posted = [];
  const result = await quiet.run(['fix'], { postNotice: (line) => { posted.push(line); return { status: 0 }; } });
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(posted, []);
  assert.match(result.out, /notice: none \(owner_notice is none\)/);
  const plain = await failedProject(t);
  const dry = await plain.run(['fix', '--dry-run']);
  assert.match(dry.out, /^big: no \(normal risk, nothing in the map's big list\)$/m);
  assert.match(dry.out, /--base feature$/m);
});
