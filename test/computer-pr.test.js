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
  assert.match(prompt, /https:\/\/github\.com\/atrislabs\/demo\.git/);
  assert.match(prompt, /\/workspace\/repos\/demo/);
  assert.match(prompt, /Create branch atris\/fix-readme from develop/);
  assert.match(prompt, /base develop/);
  assert.match(prompt, /Do NOT merge/);
  assert.match(prompt, /Never force push/);
  assert.match(prompt, /STEP_FAILED=6 no changes/);
  assert.match(prompt, /title "Fix the README typo"/);
  assert.match(prompt, /TASK START\nFix the README typo\nTASK END$/);
  assert.ok(!/--force|push -f/.test(prompt));
});

test('buildPullRequestPrompt without base uses the default branch', () => {
  const prompt = buildPullRequestPrompt({ owner: 'a', name: 'b', task: 'do it', branch: 'atris/x' });
  assert.match(prompt, /create branch atris\/x from that default branch/);
  assert.match(prompt, /base the default branch/);
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
  assert.match(h.calls.err.join('\n'), /could not start: busy/);
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

test('the instruction clones into a fresh folder and never asks to delete one', () => {
  const { buildPullRequestPrompt } = require('../lib/computer-pr');
  const text = buildPullRequestPrompt({ owner: 'acme', name: 'shop', task: 'Fix the typo in the readme.', branch: 'atris/fix-typo-20261114-1200' });
  assert.match(text, /\/workspace\/repos\/shop--atris-fix-typo-20261114-1200/);
  assert.match(text, /Never delete or reuse any existing folder/);
  assert.doesNotMatch(text, /delete that folder first/);
});

test('titles use the first sentence or complete words within the limit', () => {
  assert.equal(titleFromTask('Delete the file docs/codeops-cloud-test.md. It was a one-time test that is no longer needed.'), 'Delete the file docs/codeops-cloud-test.md');
  assert.equal(titleFromTask('This is a deliberately long first sentence that must end on a complete word without trailing punctuation.'), 'This is a deliberately long first sentence that must end on a complete');
  assert.equal(titleFromTask('Fix it. Then run checks.'), 'Fix it');
});
