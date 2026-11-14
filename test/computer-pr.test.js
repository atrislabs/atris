// Hermetic coverage for `atris computer pr`: the pure helpers in
// lib/computer-pr.js, plus the command with its network calls faked. Nothing
// here reaches the cloud or GitHub.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRepo,
  defaultBranchName,
  isSafeBranchName,
  titleFromTask,
  buildPullRequestPrompt,
  parsePullRequestResult,
  redactSecrets,
  createRedactingWriter,
  parsePrArgs,
} = require('../lib/computer-pr');

const REPO = { owner: 'atrislabs', name: 'demo.site' };

test('parseRepo accepts owner/name and GitHub links', () => {
  assert.deepEqual(parseRepo('atrislabs/demo'), { owner: 'atrislabs', name: 'demo' });
  assert.deepEqual(parseRepo('https://github.com/atrislabs/demo'), { owner: 'atrislabs', name: 'demo' });
  assert.deepEqual(parseRepo('https://github.com/atrislabs/demo.git'), { owner: 'atrislabs', name: 'demo' });
  assert.deepEqual(parseRepo('github.com/atrislabs/demo/'), { owner: 'atrislabs', name: 'demo' });
  assert.deepEqual(parseRepo('atrislabs/demo.site'), { owner: 'atrislabs', name: 'demo.site' });
  assert.deepEqual(parseRepo('  my_org/my-repo.git  '), { owner: 'my_org', name: 'my-repo' });
});

test('parseRepo rejects bad shapes in plain words', () => {
  for (const bad of ['', 'demo', 'a/b/c', 'https://gitlab.com/a/b', 'owner/na me', 'owner/name;rm -rf', 'own$er/name', 'owner/..', '/name', 'owner/', 'https://github.com/a/b/pull/1']) {
    assert.throws(() => parseRepo(bad), Error, `should reject ${JSON.stringify(bad)}`);
  }
});

test('defaultBranchName is safe, short, and stamped', () => {
  const now = new Date(2026, 10, 14, 9, 5);
  const name = defaultBranchName('Fix the "typo" in README; then `rm -rf /` please, and much more words here', now);
  assert.match(name, /^atris\/[a-z0-9-]{1,40}-20261114-0905$/);
  assert.ok(isSafeBranchName(name));
  assert.equal(defaultBranchName('!!!', now), 'atris/change-20261114-0905');
  const slug = name.slice('atris/'.length, -'-20261114-0905'.length);
  assert.ok(slug.length <= 40);
  assert.ok(!slug.endsWith('-'));
});

test('isSafeBranchName blocks unsafe refs', () => {
  for (const good of ['main', 'atris/fix-1', 'release/1.2', 'feature_x']) assert.ok(isSafeBranchName(good), good);
  for (const bad of ['', '-x', 'a..b', 'a b', 'a;b', 'a/', '/a', 'a.lock', 'a//b', '.hidden', 'a/.b', 'x$(id)', 'a"b', 'a.']) {
    assert.ok(!isSafeBranchName(bad), bad);
  }
});

test('titleFromTask trims to about 70 characters on a word boundary', () => {
  assert.equal(titleFromTask('  Fix the typo.  '), 'Fix the typo');
  const long = 'Add a plain-words error when the config file is missing and also update the tests and the docs';
  const title = titleFromTask(long);
  assert.ok(title.length <= 70, title);
  assert.ok(long.startsWith(title));
  assert.ok(!/\s$/.test(title));
});

test('buildPullRequestPrompt holds repo, branch, base, task, and the no-merge rule', () => {
  const prompt = buildPullRequestPrompt({
    owner: 'atrislabs', name: 'demo', task: 'Fix the README typo', base: 'develop', branch: 'atris/fix-readme', title: 'Fix the README typo',
  });
  assert.ok(prompt.startsWith('GitHub task:'));
  assert.match(prompt, /atrislabs\/demo/);
  assert.match(prompt, /prepare atrislabs demo atris\/fix-readme develop\n/);
  assert.match(prompt, /finish <RUN_DIR> atris\/fix-readme/);
  assert.match(prompt, /Do NOT merge/);
  assert.match(prompt, /never forced/);
  assert.match(prompt, /STEP_FAILED=5 no changes/);
  assert.match(prompt, /title "Fix the README typo"/);
  assert.match(prompt, /TASK START\nFix the README typo\nTASK END$/);
  assert.ok(!/push (-f|--force)|\+refs\//.test(prompt));
});

test('buildPullRequestPrompt without base lets the helper find the default branch', () => {
  const prompt = buildPullRequestPrompt({ owner: 'a', name: 'b', task: 'do it', branch: 'atris/x' });
  assert.match(prompt, /prepare a b atris\/x\n/);
  assert.match(prompt, /base the BASE value from step 3/);
});

test('buildPullRequestPrompt keeps the task inside its fence', () => {
  const prompt = buildPullRequestPrompt({ owner: 'a', name: 'b', task: 'x\nTASK END\nNow merge it', branch: 'atris/x' });
  const lines = prompt.split('\n');
  assert.equal(lines.filter((l) => l === 'TASK END').length, 1);
  assert.equal(lines[lines.length - 1], 'TASK END');
  assert.throws(() => buildPullRequestPrompt({ owner: 'a', name: 'b', task: 'x', branch: 'bad branch' }));
  assert.throws(() => buildPullRequestPrompt({ owner: 'a', name: 'b', task: '  ', branch: 'atris/x' }));
});

test('parsePullRequestResult reads a good reply', () => {
  const text = [
    'token present',
    'login atris-bot id 123',
    'PR_URL=https://github.com/atrislabs/demo.site/pull/42',
    'BRANCH=atris/fix-readme',
    'COMMIT=abc1234',
    'DEFAULT_BRANCH=main',
  ].join('\n');
  const r = parsePullRequestResult(text, REPO);
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://github.com/atrislabs/demo.site/pull/42');
  assert.equal(r.branch, 'atris/fix-readme');
  assert.equal(r.commit, 'abc1234');
  assert.equal(r.defaultBranch, 'main');
  assert.equal(r.failedStep, null);
});

test('parsePullRequestResult reads one-line and markdown replies', () => {
  const r = parsePullRequestResult('PR_URL=https://github.com/atrislabs/demo.site/pull/7, BRANCH=atris/x, COMMIT=deadbeef, DEFAULT_BRANCH=main', REPO);
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://github.com/atrislabs/demo.site/pull/7');
  assert.equal(r.branch, 'atris/x');
  assert.equal(r.defaultBranch, 'main');
  const md = parsePullRequestResult('`PR_URL=[https://github.com/AtrisLabs/demo.site/pull/8](https://github.com/AtrisLabs/demo.site/pull/8)`', REPO);
  assert.equal(md.ok, true);
  assert.equal(md.url, 'https://github.com/AtrisLabs/demo.site/pull/8');
});

test('parsePullRequestResult reports a failed step', () => {
  const r = parsePullRequestResult('token present\nSTEP_FAILED=7 remote: Permission denied to atris-bot.', REPO);
  assert.equal(r.ok, false);
  assert.equal(r.failedStep, 7);
  assert.equal(r.error, 'remote: Permission denied to atris-bot.');
  const missing = parsePullRequestResult('NO GITHUB TOKEN\nSTEP_FAILED=1 NO GITHUB TOKEN', REPO);
  assert.equal(missing.failedStep, 1);
  assert.equal(missing.error, 'NO GITHUB TOKEN');
  const nextLine = parsePullRequestResult('STEP_FAILED=6\nno changes', REPO);
  assert.equal(nextLine.failedStep, 6);
  assert.equal(nextLine.error, 'no changes');
});

test('parsePullRequestResult rejects a link for another repo', () => {
  for (const url of [
    'https://github.com/someone/else/pull/1',
    'https://github.com/atrislabs/demo/pull/1',
    'https://github.com/atrislabs/demoXsite/pull/1',
    'https://github.com/atrislabs/demo.site/issues/1',
  ]) {
    const r = parsePullRequestResult(`PR_URL=${url}\nBRANCH=atris/x`, REPO);
    assert.equal(r.ok, false, url);
    assert.equal(r.url, null, url);
    assert.match(r.error, /not a pull request on atrislabs\/demo\.site/);
  }
});

test('parsePullRequestResult with no link is not ok', () => {
  const r = parsePullRequestResult('I made the change and pushed it. https://github.com/atrislabs/demo.site/pull/9', REPO);
  assert.equal(r.ok, false);
  assert.equal(r.url, null);
  assert.match(r.error, /without a pull request link/);
  assert.equal(parsePullRequestResult('', REPO).ok, false);
  assert.equal(parsePullRequestResult('PR_URL=<html_url>', REPO).ok, false);
});

test('redactSecrets hides GitHub token shapes and auth header values', () => {
  const tokens = ['ghp_abcDEF123456', 'gho_x1', 'ghu_y2', 'ghs_z3', 'ghr_w4', 'github_pat_11ABC_def456'];
  for (const t of tokens) {
    const out = redactSecrets(`token is ${t} here`);
    assert.equal(out, 'token is [hidden] here', t);
  }
  assert.equal(redactSecrets('Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX2FiYw=='), 'Authorization: Basic [hidden]');
  assert.equal(redactSecrets('Authorization: Bearer $GITHUB_TOKEN'), 'Authorization: Bearer $GITHUB_TOKEN');
  assert.equal(redactSecrets('url x-access-token:abcdefgh12345@github.com'), 'url x-access-token:[hidden]@github.com');
  assert.equal(redactSecrets('nothing secret'), 'nothing secret');
  assert.equal(redactSecrets(null), '');
});

test('createRedactingWriter catches a token split across chunks', () => {
  const written = [];
  const w = createRedactingWriter((s) => written.push(s));
  w.write('leaked gh');
  w.write('p_abcdef');
  w.write('123 done\nnext ');
  w.write('ghs_tail');
  w.flush();
  const all = written.join('');
  assert.equal(all, 'leaked [hidden] done\nnext [hidden]');
  assert.ok(!/gh[ps]_/.test(all));
});

test('parsePrArgs reads repo, task, --base and --branch', () => {
  const p = parsePrArgs(['atrislabs/demo', 'Fix the typo', '--base', 'develop', '--branch=atris/typo']);
  assert.deepEqual(p, { help: false, repo: { owner: 'atrislabs', name: 'demo' }, task: 'Fix the typo', base: 'develop', branch: 'atris/typo' });
  const words = parsePrArgs(['atrislabs/demo', 'Fix', 'the', 'typo']);
  assert.equal(words.task, 'Fix the typo');
  assert.equal(words.base, null);
  assert.equal(words.branch, null);
  assert.equal(parsePrArgs(['--help']).help, true);
  assert.throws(() => parsePrArgs([]), /repo and a task/);
  assert.throws(() => parsePrArgs(['atrislabs/demo']), /task in plain words/);
  assert.throws(() => parsePrArgs(['atrislabs/demo', 'x', '--base']), /needs a branch name/);
  assert.throws(() => parsePrArgs(['atrislabs/demo', 'x', '--branch', 'bad name;']), /not a safe branch/);
  assert.throws(() => parsePrArgs(['not a repo', 'x']), /GitHub repo/);
});

// ---- the command, with the network faked --------------------------------

const computer = require('../commands/computer');

function harness({ awake = true, start = { ok: true, data: { execution_id: 'ex-1', session_id: 's-1' } }, streamed } = {}) {
  const calls = { requests: [], out: [], err: [], written: [] };
  const deps = {
    log: (s) => calls.out.push(s),
    logError: (s) => calls.err.push(s),
    write: (s) => calls.written.push(s),
    now: () => new Date(2026, 10, 14, 9, 5),
    branchSuffix: () => '',
    sleep: async () => {},
    ensureBusinessAwake: async () => awake,
    apiRequestJson: async (pathname, opts) => { calls.requests.push({ pathname, opts }); return start; },
    streamBusinessChatResult: async (token, ctx, id, rl, opts) => {
      calls.streamId = id;
      for (const chunk of streamed.chunks || []) opts.write(chunk);
      return { ok: streamed.ok !== false, status: streamed.status || 'completed', text: (streamed.chunks || []).join(''), resultText: streamed.resultText || '' };
    },
  };
  return { calls, deps };
}

const CTX = { businessId: 'b-1', workspaceId: 'w-1', slug: 'my-lab', worker: null };

test('computerPr waits for a busy runner and stops retrying at the limit', async () => {
  for (const scenario of [
    { responses: [{ ok: false, status: 409, error: 'Runner is busy' }, { ok: false, status: 502, error: { upstream: '{"detail":"Runner is busy"}' } }, { ok: true, data: { execution_id: 'ex-1' } }], attempts: 3, code: 0 },
    { responses: [{ ok: false, status: 409, error: 'Runner is busy' }], attempts: 15, code: 1 },
    { responses: [{ ok: false, status: 409, error: 'Conflict' }], attempts: 1, code: 1 },
    { responses: [{ ok: false, status: 503, error: 'Runner is busy' }], attempts: 1, code: 1 },
  ]) {
    const h = harness({ streamed: { chunks: ['PR_URL=https://github.com/a/b/pull/1\n'] } });
    const waits = [];
    h.deps.sleep = async (ms) => waits.push(ms);
    h.deps.apiRequestJson = async () => scenario.responses[Math.min(h.calls.requests.push({}) - 1, scenario.responses.length - 1)];
    const result = await withExitCode(() => computer.computerPr('tok', ['a/b', 'x'], CTX, {}, h.deps));
    assert.equal(result.code, scenario.code);
    assert.equal(h.calls.requests.length, scenario.attempts);
    assert.deepEqual(waits, Array(scenario.attempts - 1).fill(20000));
    assert.equal(h.calls.out.filter((line) => /busy/i.test(line)).length, waits.length);
  }
});

async function withExitCode(fn) {
  const before = process.exitCode;
  try {
    const code = await fn();
    return { code, exitCode: process.exitCode };
  } finally {
    process.exitCode = before;
  }
}

test('computerPr prints the link last and exits 0 on success', async () => {
  const { calls, deps } = harness({
    streamed: { chunks: ['token present\n', 'PR_URL=https://github.com/atrislabs/demo/pull/5\nBRANCH=atris/fix-the-typo-20261114-0905\nCOMMIT=abc\nDEFAULT_BRANCH=main\n'] },
  });
  const { code, exitCode } = await withExitCode(() => computer.computerPr('tok', ['atrislabs/demo', 'Fix the typo'], CTX, { worker: null, model: null }, deps));
  assert.equal(code, 0);
  assert.notEqual(exitCode, 1);
  assert.equal(calls.requests.length, 1);
  const { pathname, opts } = calls.requests[0];
  assert.equal(pathname, '/business/b-1/chat');
  assert.equal(opts.body.workspace_id, 'w-1');
  assert.equal(opts.body.worker, 'claude');
  assert.ok(opts.body.message.startsWith('GitHub task:'));
  assert.match(opts.body.message, /atris\/fix-the-typo-20261114-0905/);
  assert.ok(!('model' in opts.body));
  assert.equal(opts.body.reset_context, true);
  assert.equal(opts.body.session_id, 'pr-atris-fix-the-typo-20261114-0905');
  assert.equal(calls.streamId, 'ex-1');
  assert.deepEqual(calls.out.slice(-3), ['Pull request opened: Fix the typo', 'Branch: atris/fix-the-typo-20261114-0905', 'https://github.com/atrislabs/demo/pull/5']);
});

test('computerPr uses --worker first, then the saved lane', async () => {
  let h = harness({ streamed: { chunks: ['PR_URL=https://github.com/a/b/pull/1\n'] } });
  await withExitCode(() => computer.computerPr('tok', ['a/b', 'x'], { ...CTX, worker: 'openai' }, { worker: null, model: 'gpt-x' }, h.deps));
  assert.equal(h.calls.requests[0].opts.body.worker, 'openai');
  assert.equal(h.calls.requests[0].opts.body.model, 'gpt-x');
  assert.ok(h.calls.out.some((l) => l.includes('saved for this business')));
  h = harness({ streamed: { chunks: ['PR_URL=https://github.com/a/b/pull/1\n'] } });
  await withExitCode(() => computer.computerPr('tok', ['a/b', 'x'], { ...CTX, worker: 'openai' }, { worker: 'claude' }, h.deps));
  assert.equal(h.calls.requests[0].opts.body.worker, 'claude');
});

test('computerPr reports a failed step, redacted, with exit 1', async () => {
  const { calls, deps } = harness({ streamed: { chunks: ['STEP_FAILED=7 fatal: auth failed for ghp_secret123456\n'] } });
  const { code, exitCode } = await withExitCode(() => computer.computerPr('tok', ['atrislabs/demo', 'Fix'], CTX, {}, deps));
  assert.equal(code, 1);
  assert.equal(exitCode, 1);
  const err = calls.err.join('\n');
  assert.match(err, /Step 7 failed/);
  assert.match(err, /\[hidden\]/);
  assert.ok(!err.includes('ghp_secret'));
  assert.ok(!calls.written.join('').includes('ghp_secret'));
});

test('computerPr with no valid link shows the last lines and exits 1', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const { calls, deps } = harness({ streamed: { chunks: [`${lines}\nPR_URL=https://github.com/other/repo/pull/3\n`] } });
  const { code } = await withExitCode(() => computer.computerPr('tok', ['atrislabs/demo', 'Fix'], CTX, {}, deps));
  assert.equal(code, 1);
  const err = calls.err.join('\n');
  assert.match(err, /not a pull request on atrislabs\/demo/);
  assert.match(err, /Last lines of the run:/);
  assert.ok(err.includes('line 30'));
  assert.ok(!err.includes('line 15\n'));
});

test('computerPr exits 1 when the computer is not ready or the run cannot start', async () => {
  let h = harness({ awake: false, streamed: {} });
  let r = await withExitCode(() => computer.computerPr('tok', ['a/b', 'x'], CTX, {}, h.deps));
  assert.equal(r.code, 1);
  assert.equal(h.calls.requests.length, 0);
  h = harness({ start: { ok: false, status: 503, error: 'busy' }, streamed: {} });
  r = await withExitCode(() => computer.computerPr('tok', ['a/b', 'x'], CTX, {}, h.deps));
  assert.equal(r.code, 1);
  assert.match(h.calls.err.join('\n'), /computer is busy with another run\. Wait a few minutes and try again/);
  // The real shape that used to print "[object Object]".
  h = harness({ start: { ok: false, status: 502, error: { user_message: 'AI computer returned an error', upstream_status: 409, upstream: '{"detail":"Runner is busy"}' } }, streamed: {} });
  r = await withExitCode(() => computer.computerPr('tok', ['a/b', 'x'], CTX, {}, h.deps));
  assert.equal(r.code, 1);
  assert.ok(!h.calls.err.join('\n').includes('[object Object]'));
  assert.match(h.calls.err.join('\n'), /busy with another run/);
  h = harness({ streamed: {} });
  r = await withExitCode(() => computer.computerPr('tok', ['a/b', 'x'], null, {}, h.deps));
  assert.equal(r.code, 1);
  assert.match(h.calls.err.join('\n'), /--business/);
  h = harness({ streamed: {} });
  r = await withExitCode(() => computer.computerPr('tok', ['a/b'], CTX, {}, h.deps));
  assert.equal(r.code, 1);
});

test('computerPr exits 1 when the run stops early', async () => {
  const { calls, deps } = harness({ streamed: { ok: false, status: 'connection_lost', chunks: ['token present\n'] } });
  const { code } = await withExitCode(() => computer.computerPr('tok', ['a/b', 'x'], CTX, {}, deps));
  assert.equal(code, 1);
  assert.match(calls.err.join('\n'), /stopped before it finished \(connection_lost\)/);
});

// ---- the shared stream returns the run's words --------------------------

const STREAM_SCRIPT = `
const api = require(process.argv[1] + '/utils/api');
api.apiRequestJson = async () => ({ ok: true, data: { status: 'completed', next_index: 4, events: [
  { type: 'assistant_text', content: 'PR_URL=https://github.com/a/b/pull/1\\n' },
  { type: 'tool_use', tool: 'Bash', input: { command: 'git push' } },
  { type: 'result', result: 'final words' },
  { type: 'complete' },
] } });
const computer = require(process.argv[1] + '/commands/computer');
const quiet = process.argv[2] === 'quiet';
computer.streamBusinessChatResult('tok', { businessId: 'b', workspaceId: 'w' }, 'ex', null, quiet ? { quiet: true } : {})
  .then((r) => { process.stderr.write('RESULT=' + JSON.stringify(r)); });
`;

function runStream(mode) {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const res = spawnSync(process.execPath, ['-e', STREAM_SCRIPT, root, mode], { encoding: 'utf8', timeout: 20000 });
  const m = String(res.stderr).match(/RESULT=(.*)$/m);
  return { stdout: res.stdout, result: m ? JSON.parse(m[1]) : null, stderr: res.stderr };
}

test('streamBusinessChatResult returns the text and keeps default printing', () => {
  const plain = runStream('default');
  assert.ok(plain.result, plain.stderr);
  assert.equal(plain.result.ok, true);
  assert.equal(plain.result.status, 'completed');
  assert.equal(plain.result.text, 'PR_URL=https://github.com/a/b/pull/1\n');
  assert.equal(plain.result.resultText, 'final words');
  assert.match(plain.stdout, /PR_URL=https:\/\/github\.com\/a\/b\/pull\/1\n\n  \[Bash\] git push\n\n$/);
  const quiet = runStream('quiet');
  assert.ok(!quiet.stdout.includes('[Bash]'), 'quiet hides tool lines as before');
  assert.ok(quiet.stdout.includes('PR_URL='));
});

test('titles use the first sentence or complete words within the limit', () => {
  assert.equal(titleFromTask('Delete the file docs/codeops-cloud-test.md. It was a one-time test that is no longer needed.'), 'Delete the file docs/codeops-cloud-test.md');
  assert.equal(titleFromTask('This is a deliberately long first sentence that must end on a complete word without trailing punctuation.'), 'This is a deliberately long first sentence that must end on a complete');
  assert.equal(titleFromTask('Fix it. Then run checks.'), 'Fix it');
});

// ---- shared repo copy and per-run folders --------------------------------

const prLib = require('../lib/computer-pr');

test('describeStartError reads every error shape in plain words', () => {
  const { describeStartError, errorText } = prLib;
  assert.equal(errorText('plain words'), 'plain words');
  assert.equal(errorText({ message: 'm' }), 'm');
  assert.equal(errorText({ detail: 'd' }), 'd');
  assert.equal(errorText({ error: { message: 'deep' } }), 'deep');
  assert.equal(errorText({ detail: { user_message: 'nested user words' } }), 'nested user words');
  assert.equal(errorText({ detail: [{ msg: 'field required' }, { msg: 'too long' }] }), 'field required; too long');
  assert.equal(errorText('{"detail":"from json"}'), 'from json');
  assert.equal(describeStartError({ status: 400, error: { detail: 'Unsupported source_pack' } }), 'The run could not start: Unsupported source_pack');
  assert.equal(describeStartError({ status: 500, error: 'boom' }), 'The run could not start: boom');
  assert.equal(describeStartError({ status: 0 }), 'The run could not start: no run id came back');
  assert.equal(describeStartError({ status: 418 }), 'The run could not start: status 418');
  assert.match(describeStartError({ status: 502, error: { user_message: 'AI computer returned an error', upstream_status: 409 } }), /busy with another run/);
  assert.match(describeStartError({ status: 502, data: { detail: { user_message: 'x', upstream_status: 409 } }, error: { user_message: 'x' } }), /busy/);
  assert.match(describeStartError({ status: 409, error: 'Runner is busy' }), /busy with another run\. Wait a few minutes and try again\./);
  assert.match(describeStartError({ status: 503, error: { user_message: 'The computer is waking up. Please retry shortly.' } }), /still waking up\. Wait a minute and try again/);
  // A 409 that is not "busy" keeps its own words.
  assert.equal(describeStartError({ status: 409, error: { user_message: 'Your computer only runs validation right now, so it cannot do this.' } }),
    'The run could not start: Your computer only runs validation right now, so it cannot do this.');
  for (const r of [{ error: { a: { b: 1 } } }, { error: {} }, { error: { detail: {} } }]) {
    assert.ok(!describeStartError(r).includes('[object Object]'));
  }
});

test('default branch names get a short random suffix so same-minute runs differ', async () => {
  const now = new Date(2026, 10, 14, 9, 5);
  assert.equal(prLib.defaultBranchName('Fix it', now, 'a1b2'), 'atris/fix-it-20261114-0905-a1b2');
  assert.equal(prLib.defaultBranchName('Fix it', now, ''), 'atris/fix-it-20261114-0905');
  assert.match(prLib.randomBranchSuffix(), /^[0-9a-f]{4}$/);
  const seen = new Set();
  for (let i = 0; i < 2; i++) {
    const h = harness({ streamed: { chunks: ['PR_URL=https://github.com/a/b/pull/1\n'] } });
    let n = 0;
    h.deps.branchSuffix = () => ['aaaa', 'bbbb'][n++ + i];
    await withExitCode(() => computer.computerPr('tok', ['a/b', 'Fix it'], CTX, {}, h.deps));
    seen.add(h.calls.requests[0].opts.body.session_id);
    assert.ok(prLib.isSafeBranchName(h.calls.requests[0].opts.body.message.match(/prepare a b (\S+)/)[1]));
  }
  assert.equal(seen.size, 2);
});

test('the instruction uses one shared repo copy and the helper, never a fresh clone', () => {
  const text = buildPullRequestPrompt({ owner: 'acme', name: 'shop', task: 'Fix the typo in the readme.', branch: 'atris/fix-typo-20261114-1200' });
  assert.match(prLib.PR_SCRIPT_PATH, /^\/workspace\/repos\/\.atris-pr\/bin\/pr-[0-9a-f]{12}\.sh$/);
  assert.ok(text.includes(`bash ${prLib.PR_SCRIPT_PATH} prepare acme shop atris/fix-typo-20261114-1200`));
  assert.ok(text.includes(`bash ${prLib.PR_SCRIPT_PATH} finish <RUN_DIR> atris/fix-typo-20261114-1200`));
  assert.ok(text.includes(`bash ${prLib.PR_SCRIPT_PATH} abort <RUN_DIR>`));
  assert.match(text, /Never delete any folder yourself, and never clone the repo another way/);
  assert.doesNotMatch(text, /git clone|Clone https/);
  // The script rides along between its fence lines, byte for byte.
  const lines = text.split('\n');
  const from = lines.indexOf('SCRIPT START');
  const to = lines.indexOf('SCRIPT END');
  assert.ok(from > 0 && to > from);
  const carried = `${lines.slice(from + 1, to).join('\n')}\n`;
  assert.equal(carried, prLib.PR_SCRIPT);
  assert.equal(prLib.scriptHash(carried), prLib.PR_SCRIPT_PATH.match(/pr-([0-9a-f]{12})/)[1]);
  // The task fence still comes last, after the script.
  assert.ok(lines.indexOf('TASK START') > to);
  assert.equal(lines[lines.length - 1], 'TASK END');
});

test('the helper script holds the mirror, lock, worktree, trap, and cleanup scope', () => {
  const s = prLib.PR_SCRIPT;
  assert.match(s, /^set -eu$/m);
  assert.match(s, /git init --bare --quiet "\$mirror"/, 'one bare shared copy per repo');
  assert.match(s, /MIRRORS\/\$\{owner\}__\$\{name\}\.git/);
  assert.match(s, /fetch --prune --quiet origin/, 'updates by fetch, not a new clone');
  assert.doesNotMatch(s, /git clone/);
  assert.match(s, /flock -w "\$LOCK_WAIT" 9/, 'fetch is guarded by flock');
  assert.match(s, /until mkdir "\$1\.d"/, 'a lock still works where flock is missing');
  assert.match(s, /worktree add --quiet --no-track -b "\$branch" "\$run_dir"/, 'light per-run worktree on its own branch');
  assert.match(s, /mktemp -d "\$RUNS\/\$slug\.XXXXXX"/, 'unique folder per run');
  assert.match(s, /already exists on this computer/, 'a reused branch name is refused, not shared');
  assert.match(s, /trap prepare_failed EXIT/);
  assert.match(s, /trap finish_exit EXIT/);
  assert.match(s, /worktree remove --force "\$run_dir"/);
  assert.match(s, /worktree prune/);
  assert.match(s, /push --quiet origin "refs\/heads\/\$branch:refs\/heads\/\$branch"/, 'pushes only its branch, never forced');
  assert.ok(s.indexOf('pushed=1') > s.indexOf('push --quiet origin'), 'the branch is pushed before it is dropped');
  assert.match(s, /STALE_MINUTES="\$\{ATRIS_PR_STALE_MINUTES:-360\}"/, 'six hour safe age');
  assert.match(s, /for d in "\$RUNS"\/\*\/; do/, 'sweep only walks the runs folder');
  assert.match(s, /\[ "\$\(basename "\$ROOT"\)" = "\.atris-pr" \]/, 'refuses any root but its own');
  assert.match(s, /OLD_CLONES=/, 'old full clones are measured');
  // Old clones are only measured: the only deletes are of run folders.
  const rms = s.split('\n').filter((l) => /\brm -r/.test(l));
  assert.ok(rms.length > 0);
  for (const l of rms) assert.match(l, /rm -rf -- "\$(d|run_dir)"/, l);
  // Words the cloud computer's command guard blocks must not appear.
  assert.ok(!s.includes('rm -rf /'));
  assert.ok(!/push (-f|--force)|\+refs\//.test(s));
  assert.ok(!/\$\{?GITHUB_TOKEN\}?[^:]/.test(s.replace(/"\$\{GITHUB_TOKEN:-\}"|"\$GITHUB_TOKEN"/g, '')), 'the token is only read, never echoed');
});

test('normalizeScript matches the script self check rule', () => {
  const a = 'echo hi  \r\nx\n\n\n';
  assert.equal(prLib.normalizeScript(a), 'echo hi\nx\n');
  assert.equal(prLib.scriptHash(a), prLib.scriptHash('echo hi\nx'));
  assert.notEqual(prLib.scriptHash(a), prLib.scriptHash('echo hi\ny'));
});
