'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { reviewCommand } = require('../commands/review');
const { upsertBlock } = require('../lib/wall-of-shame');

const SPEC = `# Spec

## Wall of shame

### Overengineering (always reviewed, 1 example)

Extra layers.

- One.

### Regex (reviewed on Sonnet)

Word matching.

### Arbitrary limits (2 examples)

Made-up caps.

- A cap.
- Another cap.

### Over-testing (checked by CI)

Net test lines must not exceed source lines added.

## Later
`;

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cr-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'SPEC.md'), SPEC);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  fs.writeFileSync(path.join(root, 'a.js'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'source');
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'a.test.js'), 'x\ny\n');
  return { root, git };
}

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) };
}

test('code-review triages, reviews each lens and counts over-testing', async () => {
  const { root, git } = repo();
  const jobs = [];
  const executeAskJob = async (job) => {
    const diff = fs.readFileSync(path.join(root, job.prompt.match(/diff in the file (\S+)\./)[1]), 'utf8');
    jobs.push({ ...job, diff });
    if (job.label === 'triage') return { ok: true, model_ran: 'haiku-x', stdout: '```json\n{"lenses":[{"lens":"arbitrary limits","relevant":false,"reason":"no caps"}]}\n```' };
    if (job.label === 'Regex') return { ok: true, stdout: 'looks fine to me' };
    return { ok: true, stdout: 'Done. {"verdict":"accept","score":91,"assessment":"Nothing extra."}' };
  };
  const io = capture();
  const code = await reviewCommand(['--json'], { root, executeAskJob, ...io });
  const report = JSON.parse(io.lines.join('\n'));

  assert.equal(code, 1);
  assert.deepEqual(report.rows.map((r) => [r.lens, r.verdict, r.score]), [
    ['Overengineering', 'accept', 91],
    ['Regex', 'no verdict', undefined],
    ['Arbitrary limits', 'not relevant', undefined],
    ['Over-testing', 'request changes', undefined],
  ]);
  assert.equal(report.rows[2].reviewer, 'haiku-x');
  assert.match(report.rows[3].assessment, /net test lines 2, source lines added 1/);
  assert.equal(jobs.find((j) => j.label === 'triage').engine, 'haiku');
  assert.equal(jobs.find((j) => j.label === 'Regex').model, 'sonnet');
  assert.ok(jobs.every((j) => j.diff.includes('a.test.js') && j.diff.includes('a.js')));
  assert.equal(fs.readdirSync(path.join(root, '.atris', 'reviews')).filter((f) => f.endsWith('.diff')).length, 0);
  const receipt = fs.readFileSync(path.join(root, report.receipt), 'utf8');
  assert.match(receipt, new RegExp(`Reviewed commit: \`${git('rev-parse', 'HEAD')}\` plus uncommitted changes`));
  assert.match(receipt, /\| Regex \| .* \| No verdict \| - \| answer held no JSON verdict/);

  fs.rmSync(path.join(root, 'test'), { recursive: true });
  const accept = async (job) => (job.label === 'triage'
    ? { ok: false, reason: 'timeout', stderr: 'slow' }
    : { ok: true, stdout: '{"verdict":"accept","score":80,"assessment":"Fine."}' });
  const again = capture();
  assert.equal(await reviewCommand(['--diff', 'HEAD~1..HEAD'], { root, executeAskJob: accept, ...again }), 0);
  assert.match(again.lines.join('\n'), /triage gave no usable answer \(timeout: slow\), so every lens was reviewed/);
  assert.match(again.lines.join('\n'), /Arbitrary limits\s+accept\s+80\/100/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('code-review init and add keep the spec human-written', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cr-'));
  const io = capture();
  assert.equal(await reviewCommand([], { root, ...io }), 2);
  assert.deepEqual(io.lines, ['no atris/SPEC.md here. Run `atris code-review init` to start one.']);
  assert.equal(await reviewCommand(['init'], { root, ...io }), 0);
  const spec = path.join(root, 'atris', 'SPEC.md');
  assert.match(fs.readFileSync(spec, 'utf8'), /### Over-testing \(checked by CI\)/);

  fs.writeFileSync(spec, SPEC);
  const now = () => new Date('2026-11-19T12:00:00Z');
  assert.equal(await reviewCommand(['add', 'Capped', 'pages', 'at', '50.', '--lens', 'arbitrary LIMITS'], { root, now, ...io }), 0);
  assert.equal(await reviewCommand(['add', 'x', '--lens', 'Nope'], { root, now, ...io }), 2);
  const after = fs.readFileSync(spec, 'utf8');
  assert.equal(after, SPEC.replace('(2 examples)', '(3 examples)').replace('- Another cap.\n', '- Another cap.\n- Capped pages at 50. (2026-11-19)\n'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('the report block replaces itself in a pull request description', () => {
  const block = (sha) => `<!-- atris-code-review:start -->\n${sha}\n<!-- atris-code-review:end -->`;
  const once = upsertBlock('Why this change.', block('a'));
  assert.equal(once, `Why this change.\n\n${block('a')}\n`);
  assert.equal(upsertBlock(once, block('b')), `Why this change.\n\n${block('b')}\n`);
});
