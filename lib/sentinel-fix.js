'use strict';

// Sentinel fix: turn a confirmed audit finding into a reviewed fix on its
// own branch.
//
//   isolate  needs a clean working tree. Makes sentinel/fix-<short-id> from
//            the current branch inside a temp git worktree made by this run.
//            Your checkout is never checked out, reset, stashed or cleaned.
//            Never merges. Pushes only with --pr, from your checkout.
//   build    a builder engine (local codex or claude, or an atris model after
//            a price is shown and accepted) writes the smallest fix plus a
//            regression test in the temp worktree.
//   prove    three checks, all required before a commit:
//              1. the suite passes on the original code and the new test
//                 alone fails there on a real failed check (not a missing
//                 module, a syntax error or a timeout)
//              2. the new test and the full suite pass with the fix
//              3. a different engine (the checker) reads the fixed source and
//                 says the attack no longer works
//   land     commits in the temp worktree, only while it is on the fix branch
//            and your branch has not moved. On any failure nothing is
//            committed. The attempt is saved as a patch, the temp worktree is
//            removed and the fix branch is deleted only while it still points
//            at the start or at the commit this run made.
//
// Tests run with an allow-listed environment (PATH, locale, a temp HOME and
// TMPDIR, CI=1, NODE_ENV=test and nothing else from your shell), with
// GIT_TERMINAL_PROMPT=0, no system or global git config and push pointed at a
// dead url in that worktree's own config.
//
// Accepted limit: the generated tests still run as your own user process.
// They are not a sandbox. A test can still read or write any file your user
// can, open network connections, undo the worktree config, or push to a plain
// folder path through a url it builds itself. The scrubbing removes the
// credentials and the easy paths. Read the new test before you run this on a
// repo you do not trust.
//
// Zero external deps (Node built-ins only).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const BRANCH_PREFIX = 'sentinel/fix-';
const LOCAL_BUILDERS = ['codex', 'claude'];
const DEFAULT_TEST_TIMEOUT_MS = 20 * 60 * 1000;
const HOSTED_BUILDER = 'atris:fast';
const HOSTED_CHECKER = 'atris:pro';
const HOSTED_BUILD_SOURCE_BYTES = 64 * 1024;
const HOSTED_CHECK_MAX_BYTES = 64 * 1024;
const HOSTED_OUTPUT_TOKENS = { builder: 8192, verifier: 4096 };
const MAX_FILE_LIST = 400;
// One miss gets one more try with the reason; a second miss stops.
const MAX_BUILD_ROUNDS = 2;
const FEEDBACK_OUTPUT_CHARS = 4000;
const PY_TEST = /(?:^|\/)test_[^/]*\.py$/;
const CO_AUTHOR = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

function audit() {
  return require('./security-audit');
}

function shortId(fingerprint) {
  return crypto.createHash('sha256').update(String(fingerprint)).digest('hex').slice(0, 8);
}

function branchFor(record) {
  return `${BRANCH_PREFIX}${shortId(record.fingerprint)}`;
}

function isHosted(engine) {
  return /^atris:[a-z0-9._-]+$/i.test(String(engine || ''));
}

// ---------------------------------------------------------------- git

function git(root, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).replace(/\n$/, '');
  } catch (e) {
    if (allowFail) return null;
    const msg = String((e.stderr && e.stderr.toString()) || e.message || e).trim().split('\n')[0];
    const err = new Error(msg || `git ${args[0]} failed`);
    err.gitFailed = true;
    throw err;
  }
}

function branchExists(root, branch) {
  return git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) !== null;
}

// The temp copy holds only what git tracks, so the packages you installed
// are missing there and Node tests cannot even start. Your node_modules is
// given to the temp copy as a private copy-on-write clone: instant, and a
// write there (an npm ci from the fix writer, a test that edits a package)
// never reaches your folder. Never a link: a link would share your folder.
// Where no clone is possible the fix runs without your packages.
//
// A Python virtual environment is not copied at all: its scripts (pip,
// pytest) name the original folder's python inside them, so even a copy
// would install into your environment. Python tests find their packages
// through your PATH, as they do when you run them yourself.
const DEPENDENCY_DIRS = ['node_modules'];
const COPIED = new Map();

// One clone command per system, or null when this system has none.
// --reflink=always, not auto: auto quietly falls back to a full copy, which
// for node_modules can be gigabytes.
function cloneCommand(src, dest, platform = process.platform) {
  if (platform === 'darwin') return ['cp', ['-c', '-R', src, dest]];
  if (platform === 'linux') return ['cp', ['-R', '--reflink=always', src, dest]];
  return null;
}

function defaultClone(src, dest, platform) {
  const cmd = cloneCommand(src, dest, platform);
  if (!cmd) return { ok: false, why: 'this system has no copy-on-write copy' };
  const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', timeout: 120000 });
  if (r.status === 0) return { ok: true };
  return { ok: false, why: 'this disk cannot make a copy-on-write copy' };
}

function copyDependencies(root, wt, { platform = process.platform, clone = defaultClone } = {}) {
  const copied = [];
  const skipped = [];
  for (const name of DEPENDENCY_DIRS) {
    const src = path.join(root, name);
    const dest = path.join(wt, name);
    let st;
    try { st = fs.lstatSync(src); } catch { continue; }
    if (!st.isDirectory() || fs.existsSync(dest)) continue;
    // Only a folder git ignores: a tracked folder is already in the copy.
    if (git(root, ['check-ignore', '-q', '--', name], { allowFail: true }) === null) continue;
    let res;
    try { res = clone(src, dest, platform); } catch (e) { res = { ok: false, why: oneLine(e.message, 120) }; }
    if (res && res.ok && fs.existsSync(dest) && !fs.lstatSync(dest).isSymbolicLink()) {
      copied.push(name);
    } else {
      try { if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest); else fs.rmSync(dest, { recursive: true, force: true }); } catch {}
      skipped.push({ name, why: (res && res.why) || 'the copy failed' });
    }
  }
  COPIED.set(path.resolve(wt), new Set(copied));
  return { copied, skipped };
}

// Removes only the private clones made for this temp copy.
function dropDependencies(wt) {
  const set = COPIED.get(path.resolve(wt));
  if (!set) return;
  for (const name of set) {
    const dest = path.join(wt, name);
    try { if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest); else fs.rmSync(dest, { recursive: true, force: true }); } catch {}
  }
  COPIED.delete(path.resolve(wt));
}

// Every changed path in the working tree, from porcelain v1 -z.
function changedPaths(root) {
  const out = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const parts = out.split('\0').filter(Boolean);
  const list = [];
  const linked = COPIED.get(path.resolve(root)) || new Set();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (code === '??' && linked.has(rel.replace(/\/$/, ''))) continue;
    list.push({ code, path: rel });
    if (code[0] === 'R' || code[0] === 'C') { list.push({ code: 'D ', path: parts[i + 1] }); i += 1; }
  }
  return list;
}

function headContent(root, rel) {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
}

function snapshot(root, files) {
  const snap = new Map();
  for (const rel of files) {
    const full = path.join(root, rel);
    snap.set(rel, fs.existsSync(full) ? fs.readFileSync(full) : null);
  }
  return snap;
}

function applySnapshot(root, snap) {
  for (const [rel, buf] of snap) {
    const full = path.join(root, rel);
    if (buf === null) { fs.rmSync(full, { force: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
  }
}

// The tree was clean when the run began. Anything changed outside `keep`
// came from a test run. Put it back.
function dropArtifacts(root, keep) {
  for (const c of changedPaths(root)) {
    if (keep.has(c.path)) continue;
    if (c.code === '??') fs.rmSync(path.join(root, c.path), { force: true, recursive: true });
    else git(root, ['checkout', 'HEAD', '--', c.path], { allowFail: true });
  }
}

function isTestFile(rel) {
  return audit().TEST_PATH.test(rel) || PY_TEST.test(rel);
}

// ---------------------------------------------------------------- tests

function detectTestCommand(root) {
  const has = (rel) => fs.existsSync(path.join(root, rel));
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const t = pkg && pkg.scripts && pkg.scripts.test;
      if (typeof t === 'string' && t.trim() && !/no test specified/i.test(t)) return 'npm test';
    } catch {}
  }
  if (has('go.mod')) return 'go test ./...';
  if (['pytest.ini', 'conftest.py', 'tox.ini', 'pyproject.toml', 'setup.py', 'setup.cfg'].some(has)) return 'pytest';
  // A small app often has only a requirements file that lists pytest.
  for (const rel of ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'dev-requirements.txt', 'Pipfile']) {
    try { if (/^\s*"?pytest"?\s*(?:[=<>~!\[;#]|$)/im.test(fs.readFileSync(path.join(root, rel), 'utf8'))) return 'pytest'; } catch {}
  }
  return null;
}

// The tests pass on the original code. A project with no tests yet is a fine
// start too: pytest says so with exit 5 and "no tests ran".
function baselinePasses(testCommand, run) {
  if (run.code === 0) return true;
  return run.code === 5 && /^\s*(?:python3? -m )?pytest\b/.test(testCommand) && /no tests ran|collected 0 items/i.test(run.output || '');
}

function npmTestScript(buf) {
  try { const pkg = JSON.parse(String(buf)); return String((pkg.scripts && pkg.scripts.test) || ''); } catch { return ''; }
}

function runTestCommand(cmd, { cwd, env = process.env, timeoutMs = DEFAULT_TEST_TIMEOUT_MS } = {}) {
  const childEnv = { ...env };
  // A test runner started from inside node --test would report to it.
  delete childEnv.NODE_TEST_CONTEXT;
  const r = spawnSync(cmd, { cwd, env: childEnv, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  return { code: r.status === null ? -1 : r.status, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), output: output.slice(-256 * 1024) };
}

// ---------------------------------------------------------------- findings

// A newer review of several places that had this repo as one part wins
// over an older review of the repo alone. Its paths start with part names,
// so it comes back with no records to fix and says which review it was.
function confirmedFindings(root) {
  const last = audit().latestReview(root);
  if (!last) return { dir: null, records: [] };
  if (last.system) return { dir: last.dir, records: [], system: { ...last.system, confirmed: (last.records || []).filter((r) => r && r.verdict === 'confirmed').length } };
  return { dir: last.dir, records: (last.records || []).filter((r) => r && r.verdict === 'confirmed') };
}

function matchFinding(records, id) {
  const want = String(id || '').trim();
  if (!want) return null;
  return records.find((r) => r.fingerprint === want || shortId(r.fingerprint) === want || branchFor(r) === want) || null;
}

function findingView(r) {
  return {
    title: r.title,
    attack_class: r.attack_class,
    description: r.description,
    root_cause: r.root_cause,
    attacker: r.attacker,
    impact: r.impact,
    intended_behavior: r.intended_behavior,
    trace: (r.trace || []).map((t) => ({ kind: t.kind, file: t.file, line: t.line, description: t.description, code: t.code })),
    conditions: r.conditions || [],
    suggested_fix: r.remediation ? r.remediation.strategy : '',
    regression_test_idea: r.remediation ? r.remediation.regression_test : '',
  };
}

function citedFiles(record) {
  const isRel = audit().isRepoRel;
  return [...new Set((record.trace || []).map((t) => t && t.file).filter(isRel))];
}

// ---------------------------------------------------------------- prompts

// The other confirmed problems in the same project, so the builder fixes
// only this one and the checker does not count a way in that belongs to
// another. Each gets its own fix.
function othersBlock(record, others) {
  const list = (others || []).filter((r) => r && r.fingerprint !== record.fingerprint).slice(0, 20);
  if (!list.length) return [];
  return ['', '## Other confirmed problems in this project (each gets its own fix, not this one)', ...list.map((r) => {
    const sink = (r.trace || [])[(r.trace || []).length - 1] || {};
    return `- ${oneLine(r.title, 200)}${sink.file ? ` (${sink.file}${sink.line ? `:${sink.line}` : ''})` : ''}`;
  })];
}

// How sentinel judges the work. Saying it up front is what makes a first
// attempt pass: most refusals were tests that never drove the attack, or
// that crashed instead of failing a check.
const PROOF_RULES = [
  '## How your work is judged',
  'Sentinel puts the original code back under your test and runs it. Your fix is kept only if all of these hold:',
  '1. Your new test FAILS on the original code, and it fails on an assertion. A crash, an import error, a missing file or a timeout does not count.',
  '2. Your new test passes with your fix, and the whole test suite passes.',
  '3. A separate reviewer reads the code and agrees the unsafe request is now stopped.',
  '',
  '## How to write the test',
  '- Write the test from the side of the person who should be stopped. Send the unsafe request through the same public entry point the finding names (the route, handler or function an outsider reaches), with the input that person controls.',
  '- Set up what that person must not reach inside the test: a second user and their record, a file outside the allowed folder, a secret value. Then assert they do not get it (for example, status 403 or 404 and the victim\'s data absent from the body).',
  '- Assert on what the outsider sees, not on internals: no mocks of the code under test, no counting calls.',
  '- Keep it self-contained: no network, no fixed ports, no files outside the repository, no symlinks, nothing left behind. Use the framework\'s own test client when there is one (supertest or calling the app directly for Express, TestClient for FastAPI, httptest for Go). If importing the app starts a server, make that start-up happen only when the file is run directly, as part of the fix.',
  '- Put the test where the project keeps tests, in its existing style. If there are no tests yet, add one file named like test_<topic>.py, <topic>.test.js or <topic>_test.go.',
];

// The tool's own last words, for a refusal a person can act on: the last
// error-looking line it printed, else its last line. Never JSON, kept short.
function toolSaid(answer) {
  if (!answer) return '';
  const split = (text) => String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^[{[]/.test(l));
  // Error-looking lines come only from the error stream: normal output can
  // hold code the tool quoted, which is not what it said.
  const err = split(answer.stderr).reverse().find((l) => /^(error|fatal)\b|error:|limit|quota|denied|unauthori[sz]ed|flagged|refus/i.test(l));
  const out = split(answer.stdout).filter((l) => !/^(tokens used|codex|user|exec|--------)$/i.test(l) && !/^[\d,]+$/.test(l));
  return oneLine(err || out[out.length - 1] || '', 160);
}

function builderPrompt(record, { testCommand, hosted = false, source = '', fileList = [], others = [], canRun = false, feedback = null }) {
  const out = [
    'You are the builder on the Atris sentinel team, fixing a defect in the owner\'s own code at their request. A code review confirmed the problem below in this repository and a different model checked it. Fix it and add a regression test.',
    '',
    '## What to do',
    '- Make the smallest change that closes the hole. Follow the suggested fix unless the source shows a smaller correct one.',
    '- Add a regression test that proves the hole is closed (rules below).',
    `- The test command is: ${testCommand}. The whole suite must pass after your change.`,
    '- Fix only this problem. Do not touch unrelated files. Do not delete, skip or weaken existing tests.',
    '- Do not commit, switch branches, push, or change git settings. Do not write outside this repository. Do not use the network.',
    '- Never install, update or remove packages: no npm install, npm ci, npm update, yarn, pnpm, pip install, uv, poetry, go get or anything like them, and do not touch node_modules or a virtual environment. Use only what is already installed. If the test needs a package that is missing, do not add it: say which one in your summary.',
  ];
  if (!hosted && canRun) {
    out.push(
      '',
      '## Order of work',
      '1. Read the cited files.',
      '2. Write the regression test first, before touching the code.',
      '3. Run only that test and see it fail on an assertion because the unsafe request still succeeds. If it passes, it does not reach the hole yet: change the test. If it crashes, fix the test.',
      '4. Make the fix.',
      `5. Run that test again and see it pass, then run the whole suite with: ${testCommand}`,
      '6. Leave both the fix and the test in place. A change with no test is refused.',
    );
  } else if (!hosted) {
    out.push(
      '',
      '## Order of work',
      '1. Read the cited files and the existing tests.',
      '2. Write the regression test first, then the fix. Leave both in place: a change with no test is refused.',
      '3. You cannot run commands in this session; sentinel runs the tests for you. So trace the test by hand: on the current code the unsafe request must succeed and an assertion must fail; with your fix it must pass. Check every import and fixture the test uses exists.',
    );
  }
  if (feedback) {
    const output = String(feedback.output || '').slice(-FEEDBACK_OUTPUT_CHARS).trim();
    out.push(
      '',
      '## Your last try was refused',
      `Reason: ${feedback.reason}.`,
      'Your files are still in this folder as you left them. Change the test, the fix or both so every check below passes.',
      ...(output ? ['What the tests printed (the end):', '```', output, '```'] : []),
    );
  }
  out.push('', ...PROOF_RULES);
  if (hosted) {
    out.push(
      '- You cannot open files in this session. The cited source is below. Put the regression test in a new file next to the project\'s other tests.',
      '',
      '## Answer',
      'Return only one JSON object: {"files":[{"path":"repo/relative/path","content":"the full new file content"}],"summary":"one plain sentence describing the change"}. List every file you change or add, each with its complete content.',
    );
  } else {
    out.push('', 'When you are done, end with one line of JSON: {"summary":"one plain sentence describing the change","test_files":["paths of the tests you added or changed"]}');
  }
  out.push('', '## Confirmed finding', JSON.stringify(findingView(record), null, 2));
  out.push(...othersBlock(record, others));
  if (hosted && fileList.length) out.push('', '## Files in the repository', fileList.join('\n'));
  if (source) out.push('', source);
  return out.join('\n');
}

function checkerPrompt(record, { diff, hosted = false, source = '', others = [] }) {
  const otherLines = othersBlock(record, others);
  return [
    'You are an independent checker on the Atris sentinel team. A security audit confirmed the problem below. A different model wrote the change shown after it. Decide from the source whether the attack still works.',
    '',
    '## How to check',
    hosted ? '- Read the change and the source below.' : '- Open the cited files and every changed file yourself. Read the code as it is now in this folder.',
    '- Follow the unsafe request from its entry point to where it does harm. Look for any path around the fix: other callers, other inputs, encodings, a second sink.',
    '- Check that the new test really sends the unsafe request.',
    otherLines.length ? '- Judge this problem only. A way in that works only through one of the other confirmed problems listed below is that problem\'s fix, not a reason to reject this one. Say "fixed" when this problem\'s own path is closed.' : '',
    '- Read-only: do not change files, run the target, or use the network.',
    '',
    '## Confirmed finding',
    JSON.stringify(findingView(record), null, 2),
    ...otherLines,
    '',
    '## The change',
    '```diff',
    diff,
    '```',
    source ? `\n${source}` : '',
    '',
    '## Answer',
    'Return only one JSON object: {"verdict":"fixed or not_fixed","reason":"one sentence on what you read"}',
  ].join('\n');
}

function hostedSourceBlock(root, files, allowed, maxBytes) {
  const blocks = [];
  let used = 0;
  for (const rel of files) {
    if (!allowed.has(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    const block = `### ${rel}\n\`\`\`\n${text}\n\`\`\``;
    if (used + block.length > maxBytes) continue;
    used += block.length;
    blocks.push(block);
  }
  return blocks.length ? ['## Source', ...blocks].join('\n\n') : '';
}

// ---------------------------------------------------------------- engines

function builderInvocation(engine, prompt, { model = '', effort = '' } = {}) {
  const { RUNNER_PROFILE_DEFS, DEFAULT_CLAUDE_RUNNER_MODEL } = require('./runner-command');
  const profile = RUNNER_PROFILE_DEFS[engine];
  const effortArgs = (() => {
    const word = String(effort || '').trim().toLowerCase();
    if (!word || !profile || !profile.effortFlag || !(profile.efforts || []).includes(word)) return [];
    const parts = profile.effortFlag.split(/\s+/).filter(Boolean);
    const last = parts.pop();
    return last.endsWith('=') ? [...parts, `${last}${word}`] : [...parts, last, word];
  })();
  if (engine === 'codex') {
    // workspace-write: codex may edit only the folder it runs in.
    return { engine, bin: 'codex', args: ['exec', ...(model ? ['-m', model] : []), ...effortArgs, '--sandbox', 'workspace-write', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--color', 'never', prompt] };
  }
  if (engine === 'claude') {
    // File tools only, no shell. acceptEdits allows edits inside the folder it runs in.
    return { engine, bin: 'claude', args: ['-p', prompt, '--model', model || DEFAULT_CLAUDE_RUNNER_MODEL, ...effortArgs, '--tools', 'Read,Glob,Grep,Edit,Write', '--permission-mode', 'acceptEdits', '--no-session-persistence'] };
  }
  throw new Error(`${engine} cannot build fixes. use Claude Code or Codex (claude or codex)`);
}

function rosterPin(engine, root) {
  try { return require('./engine-ask').askRosterPin(engine, root) || {}; } catch { return {}; }
}

async function defaultRunBuilder({ engine, prompt, root, env, timeoutMs }) {
  const { runAskProcess } = require('./engine-ask');
  const pin = rosterPin(engine, root);
  const inv = builderInvocation(engine, prompt, { model: pin.roster_model || '', effort: pin.roster_effort || '' });
  return runAskProcess(inv, { cwd: root, timeoutMs, env });
}

async function defaultRunChecker({ engine, prompt, root, env, timeoutMs }) {
  const { runAskProcess, buildReadOnlyEngineInvocation } = require('./engine-ask');
  const pin = rosterPin(engine, root);
  const inv = buildReadOnlyEngineInvocation(engine, prompt, pin.roster_model || '', { timeoutMs, effort: pin.roster_effort || '', noWeb: true });
  return runAskProcess(inv, { cwd: inv.cwd || root, timeoutMs, env });
}

// Pick the builder and checker. They must differ.
// Only these engines may build or check: local codex, local claude, or an
// atris model (which always goes through the price and a yes).
function allowedEngine(name) {
  return LOCAL_BUILDERS.includes(name) || isHosted(name);
}

// Pick the builder and checker. They must differ.
function resolveFixEngines({ engine = null, builder = null, verifier = null, env = process.env, available = null, signedIn = null } = {}) {
  const cloud = require('./sentinel-cloud');
  const has = available || ((name) => cloud.localEngineAvailable(name, { env }));
  // false only when the tool clearly said it is signed out. A test that
  // injects `available` and no `signedIn` never runs the real tools.
  const signed = signedIn || (available ? () => null : (name) => cloud.engineSignedIn(name, { env }));
  const seen = new Map();
  const ready = (name) => { if (!seen.has(name)) seen.set(name, signed(name)); return seen.get(name) !== false; };
  const picked = resolveFixPick({ engine, builder, verifier, has, ready });
  for (const name of [picked.builder, picked.verifier]) {
    if (!isHosted(name) && !ready(name)) throw new Error(`${name} is installed but not signed in, so it cannot write or check a fix. sign in once with: ${cloud.signInHow(name)}, then try again`);
  }
  return picked;
}

function resolveFixPick({ engine, builder, verifier, has, ready }) {
  if (engine && engine !== 'atris' && engine !== 'local') throw new Error('--engine must be atris or local');
  for (const [flag, name] of [['--builder', builder], ['--verifier', verifier]]) {
    if (name && !allowedEngine(name)) throw new Error(`${flag} ${name} is not allowed. use codex, claude or an atris model like atris:pro`);
  }
  if (engine === 'atris' && (builder || verifier)) throw new Error('pick --engine atris or --builder and --verifier, not both');
  if (engine === 'atris') return { builder: HOSTED_BUILDER, verifier: HOSTED_CHECKER };
  if (engine === 'local' && ((builder && isHosted(builder)) || (verifier && isHosted(verifier)))) throw new Error('--engine local runs only Claude Code or Codex on this computer');
  let b = builder;
  if (!b) b = LOCAL_BUILDERS.find((n) => has(n) && ready(n)) || LOCAL_BUILDERS.find((n) => has(n)) || null;
  if (!b) throw new Error('a fix needs Claude Code or Codex on this computer, and neither was found. install one and sign in, or add --engine atris');
  let v = verifier;
  if (!v) v = isHosted(b) ? HOSTED_CHECKER : (LOCAL_BUILDERS.find((n) => n !== b && has(n) && ready(n)) || null);
  // Only one tool is ready and the person named neither: it checks its own
  // fix in a fresh session. The failing test and the full test suite still
  // have to pass, and the landing says the check was not a second tool.
  if (!v && !builder && !verifier) return { builder: b, verifier: b, same: true };
  if (!v) throw new Error(`the check needs a second tool besides ${b}. install ${b === 'codex' ? 'claude' : 'codex'} or name one with --verifier`);
  if (v === b) throw new Error('the checker must be a different engine than the builder');
  return { builder: b, verifier: v };
}

function lastJson(text, accept) {
  return audit().extractJson(text, accept);
}

// Paths a hosted builder may write: inside the repo, not .git, not a key or
// .env-style file. An existing file must be one it was allowed to see.
function hostedWritable(root, rel, allowed) {
  const a = audit();
  if (!a.isRepoRel(rel)) return false;
  const norm = path.posix.normalize(rel);
  if (norm !== rel || rel.split('/').includes('.git')) return false;
  if (a.sensitiveFile(rel)) return false;
  const full = path.join(root, rel);
  let rootReal = root;
  try { rootReal = fs.realpathSync(root); } catch {}
  let cur = path.dirname(full);
  while (!fs.existsSync(cur)) cur = path.dirname(cur);
  const real = fs.realpathSync(cur);
  const relReal = path.relative(rootReal, real);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) return false;
  if (fs.existsSync(full)) {
    if (fs.lstatSync(full).isSymbolicLink()) return false;
    if (!allowed.has(rel)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- isolation

// Environment for generated tests: an allow-list. Nothing from your shell
// passes except PATH, locale, terminal type, an active Python virtual
// environment path and on Windows the few names a process needs to start.
// Everything else (tokens, keys, DATABASE_URL and any other url that may hold
// a password) stays out. HOME, TMPDIR and the Go folders point inside the
// temp copy, git cannot prompt and reads no system or global config.
const PASS_EXACT = ['PATH', 'TERM'];
const PASS_WINDOWS = ['PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'ComSpec', 'WINDIR', 'windir'];
const PASS_LOCALE = /^(?:LANG|LANGUAGE|LC_[A-Z_]+)$/;

function scrubbedEnv(env, base, { platform = process.platform } = {}) {
  const src = env || {};
  const out = {};
  for (const k of PASS_EXACT) if (typeof src[k] === 'string') out[k] = src[k];
  for (const k of Object.keys(src)) if (PASS_LOCALE.test(k)) out[k] = src[k];
  if (platform === 'win32') for (const k of PASS_WINDOWS) if (typeof src[k] === 'string') out[k] = src[k];
  // A virtual environment is a folder path. One that carries a url or a login is refused.
  if (typeof src.VIRTUAL_ENV === 'string' && path.isAbsolute(src.VIRTUAL_ENV) && !/[@:]\/\/|@/.test(src.VIRTUAL_ENV)) out.VIRTUAL_ENV = src.VIRTUAL_ENV;
  const home = path.join(base, 'home');
  const tmp = path.join(base, 'tmp');
  for (const dir of [home, tmp]) fs.mkdirSync(dir, { recursive: true });
  Object.assign(out, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    CI: '1',
    NODE_ENV: 'test',
    PYTHONDONTWRITEBYTECODE: '1',
    GOPATH: path.join(base, 'go'),
    GOCACHE: path.join(base, 'go-cache'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
  });
  return out;
}

const NO_PUSH_URL = 'atris-sentinel-push-disabled://blocked';
const PUSH_PREFIXES = ['https://', 'http://', 'ssh://', 'git://', 'git@', 'file://', '/', './', '../'];

// Pushing from the temp worktree goes nowhere: every remote gets a dead
// pushurl and every url form is rewritten to a dead one, in that worktree's
// own config only.
function disablePush(root, wt) {
  const had = git(root, ['config', '--get', 'extensions.worktreeConfig'], { allowFail: true });
  let enabled = false;
  if (String(had).trim() !== 'true') { git(root, ['config', 'extensions.worktreeConfig', 'true']); enabled = true; }
  const remotes = (git(wt, ['remote'], { allowFail: true }) || '').split('\n').filter(Boolean);
  for (const r of remotes) git(wt, ['config', '--worktree', `remote.${r}.pushurl`, NO_PUSH_URL]);
  for (const p of PUSH_PREFIXES) git(wt, ['config', '--worktree', '--add', `url.${NO_PUSH_URL}.pushInsteadOf`, p]);
  git(wt, ['config', '--worktree', 'push.default', 'nothing']);
  return { enabled };
}

// Turn the worktree config switch back off when this run turned it on and no
// other linked worktree is left.
function restoreWorktreeConfig(root, state) {
  if (!state || !state.enabled) return;
  const count = (git(root, ['worktree', 'list', '--porcelain'], { allowFail: true }) || '').split('\n').filter((l) => l.startsWith('worktree ')).length;
  if (count <= 1) git(root, ['config', '--unset', 'extensions.worktreeConfig'], { allowFail: true });
}

// ---------------------------------------------------------------- proof

// The command that runs only the given test files, by their language.
// null when sentinel does not know a runner for them.
function singleTestCommand(files, wt) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  if (files.every((f) => /\.(?:c|m)?js$/.test(f))) return { runner: 'node', cmd: `node --test ${files.map(q).join(' ')}` };
  if (files.every((f) => /\.py$/.test(f))) return { runner: 'pytest', cmd: `python3 -m pytest -q -p no:cacheprovider ${files.map(q).join(' ')}` };
  if (files.every((f) => /_test\.go$/.test(f))) {
    const names = [];
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(wt, f), 'utf8'); } catch {}
      for (const m of text.matchAll(/^func\s+(Test\w+)\s*\(\s*\w+\s+\*testing\.T\s*\)/gm)) names.push(m[1]);
    }
    if (!names.length) return null;
    const dirs = [...new Set(files.map((f) => `./${path.posix.dirname(f)}`))];
    return { runner: 'go', cmd: `go test -count=1 ${dirs.map(q).join(' ')} -run ${q(`^(${names.join('|')})$`)}` };
  }
  return null;
}

// Output that means the test broke for a reason other than a failed check.
const NOT_A_CHECK = {
  node: /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_REQUIRE|SyntaxError|ReferenceError|TypeError|is not a function|is not defined|is not a constructor|cannot read propert|timed out|testTimeoutFailure|hookFailed|cancelledByParent/i,
  pytest: /ImportError|ModuleNotFoundError|SyntaxError|IndentationError|NameError|AttributeError|TypeError|errors? during collection|Interrupted|\bERROR\b|Timeout|fixture '.*' not found/,
  go: /\[build failed\]|\[setup failed\]|panic:|undefined:|cannot find package|no required module|syntax error|test timed out|no test files|imported and not used|declared and not used/,
};
// Output that shows a check in the test failed.
const REAL_FAILURE = {
  node: /AssertionError|ERR_ASSERTION/,
  pytest: /^E\s+(?:assert\b|AssertionError)/m,
  go: /^\s*--- FAIL: /m,
};

// A real regression proof: the run failed because a check in the test
// failed, not because something was missing, broken or slow. Anything
// unclear counts as no proof.
function realFailure(runner, run) {
  if (!NOT_A_CHECK[runner] || run.timedOut || run.code === 0 || run.code === -1) return false;
  if (runner === 'pytest' && run.code !== 1) return false;
  if (NOT_A_CHECK[runner].test(run.output)) return false;
  return REAL_FAILURE[runner].test(run.output);
}

// ---------------------------------------------------------------- one fix

function patchDir(env, repo, short) {
  const home = env.HOME || os.homedir();
  return path.join(home, '.atris', 'sentinel', 'fixes', `${repo}-${short}`);
}

function saveAttempt(wt, env, repo, short) {
  try {
    if (!fs.existsSync(wt) || !changedPaths(wt).length) return null;
    git(wt, ['add', '-A']);
    const patch = execFileSync('git', ['diff', '--cached', '--binary', 'HEAD'], { cwd: wt, maxBuffer: 64 * 1024 * 1024 });
    if (!patch.length) return null;
    const dir = patchDir(env, repo, short);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'attempt.patch');
    fs.writeFileSync(file, patch, { mode: 0o600 });
    return file;
  } catch { return null; }
}

// What the last test run printed, kept next to the attempt so a refusal can
// be read. It stays on this computer.
function saveTestOutput(env, repo, short, last) {
  if (!last || !last.output) return null;
  try {
    const dir = patchDir(env, repo, short);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'test-output.txt');
    fs.writeFileSync(file, `$ ${last.cmd}\n${last.output.slice(-64 * 1024)}`, { mode: 0o600 });
    return file;
  } catch { return null; }
}

function diffText(root, files) {
  const parts = [];
  for (const rel of files) {
    const tracked = headContent(root, rel) !== null;
    const args = tracked ? ['diff', 'HEAD', '--', rel] : ['diff', '--no-index', '--', '/dev/null', rel];
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    parts.push(String(r.stdout || ''));
  }
  return parts.join('\n').trim();
}

function oneLine(text, max = 300) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function commitMessage(record, verifier) {
  const title = oneLine(record.title, 200).replace(/[.\s]+$/, '');
  const subject = `Fix: ${title}`.slice(0, 100);
  return [
    subject,
    '',
    `Sentinel finding ${record.fingerprint}.`,
    `The new regression test fails on the old code and passes with this change. ${verifier} checked from source that the attack no longer works.`,
    'Made by atris sentinel fix. Review before merging.',
    '',
    CO_AUTHOR,
  ].join('\n');
}

function refSha(root, ref) {
  return git(root, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true });
}

// The whole fix runs in a temp worktree on the fix branch. The user's
// checkout is never checked out, reset, stashed or cleaned.
async function fixOne(root, record, ctx) {
  const { from, testCommand, engines, env, runBuilder, runChecker, hostedRun, allowed, timeouts, log } = ctx;
  const others = ctx.others || [];
  const short = shortId(record.fingerprint);
  const branch = branchFor(record);
  const ref = `refs/heads/${branch}`;
  const repo = audit().repoName(root);
  const result = { fingerprint: record.fingerprint, short_id: short, title: record.title, branch, from, ok: false, committed: false, proofs: {} };
  if (branchExists(root, branch)) {
    result.reason = `a fix branch for this finding already exists: ${branch}`;
    result.branch = null;
    return result;
  }
  const start = refSha(root, `refs/heads/${from}`);
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `atris-sentinel-fix-${short}-`));
  const wt = path.join(tmpBase, 'repo');
  let made = null;
  let pushState = null;
  const testEnv = scrubbedEnv(env, path.join(tmpBase, 'env'));
  let lastRun = null;
  const runTests = (cmd) => {
    const r = runTestCommand(cmd, { cwd: wt, env: testEnv, timeoutMs: timeouts.test });
    lastRun = { cmd, output: r.output };
    return r;
  };
  const removeWorktree = () => {
    dropDependencies(wt);
    if (fs.existsSync(wt)) git(root, ['worktree', 'remove', '--force', '--force', wt], { allowFail: true });
    fs.rmSync(tmpBase, { recursive: true, force: true });
    git(root, ['worktree', 'prune'], { allowFail: true });
    try { restoreWorktreeConfig(root, pushState); } catch {}
  };
  const fail = (reason) => {
    result.reason = reason;
    result.patch = saveAttempt(wt, env, repo, short);
    result.test_output = saveTestOutput(env, repo, short, lastRun);
    removeWorktree();
    // Delete the fix branch only while it still points at a commit this run made or at the start.
    const tip = refSha(root, ref);
    if (tip && (tip === start || (made && tip === made))) {
      git(root, ['update-ref', '-d', ref, tip], { allowFail: true });
      result.branch = null;
    } else if (tip) {
      result.reason = `${reason}. the branch ${branch} now points at a commit this run did not make and was left alone`;
    } else {
      result.branch = null;
    }
    return result;
  };
  try {
    git(root, ['worktree', 'add', '-q', '-b', branch, wt, start]);
    pushState = disablePush(root, wt);
    const deps = (ctx.copyDependencies || copyDependencies)(root, wt);
    for (const s of deps.skipped) log(`your ${s.name} is not used for this fix: ${s.why}, and sharing your own folder could change it. tests that need those packages may fail`);
    const branchOk = () => git(wt, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true }) === ref && refSha(root, ref) === start;

    log(`running the tests on the original code: ${testCommand}`);
    const base = runTests(testCommand);
    if (!baselinePasses(testCommand, base)) return fail(`the tests already fail on the original code before any change. run ${testCommand} to see why, fix that, then try again`);
    dropArtifacts(wt, new Set());

    // A local builder gets a second round when the proof refuses its first
    // try for a reason it can fix: it sees the exact reason and what the
    // tests printed. A hosted builder was priced for one round.
    const rounds = isHosted(engines.builder) ? 1 : MAX_BUILD_ROUNDS;
    let feedback = null;
    let files; let tests; let src; let single; let settle;
    for (let round = 1; ; round++) {
    // Returns a reason the builder can act on, or null when this round passed.
    const retry = (reason) => {
      if (round >= rounds) return fail(reason);
      feedback = { reason, output: lastRun && lastRun.output ? lastRun.output : '' };
      log(`not proven yet: ${reason}. giving ${engines.builder} one more try with that reason`);
      return null;
    };
    result.proofs = {};
    log(round === 1 ? `asking ${engines.builder} for the smallest fix and a regression test` : `asking ${engines.builder} to try again`);
    let summary = '';
    let builderSaid = '';
    let declared = [];
    if (isHosted(engines.builder)) {
      const fileList = [...allowed].slice(0, MAX_FILE_LIST);
      const prompt = builderPrompt(record, { testCommand, hosted: true, others, fileList, source: hostedSourceBlock(wt, citedFiles(record), allowed, HOSTED_BUILD_SOURCE_BYTES) });
      const [answer] = await hostedRun([{ engine: engines.builder, prompt, max_output_tokens: HOSTED_OUTPUT_TOKENS.builder }]);
      if (!answer || answer.ok === false) return fail(`the builder did not answer: ${oneLine(answer && answer.reason, 200) || 'no answer'}`);
      const parsed = lastJson(answer.stdout, (v) => Array.isArray(v.files));
      if (!parsed || !parsed.files.length) return fail('the builder answer had no files to change');
      for (const f of parsed.files) {
        if (!f || typeof f.path !== 'string' || typeof f.content !== 'string' || !hostedWritable(wt, f.path, allowed)) return fail(`the builder tried to write a file it may not touch: ${oneLine(f && f.path, 120) || 'unnamed'}`);
      }
      for (const f of parsed.files) {
        const full = path.join(wt, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content);
      }
      summary = oneLine(parsed.summary, 300);
    } else {
      const prompt = builderPrompt(record, { testCommand, others, canRun: engines.builder === 'codex', feedback });
      const answer = await runBuilder({ engine: engines.builder, prompt, root: wt, env, timeoutMs: timeouts.build });
      builderSaid = toolSaid(answer);
      if (!answer || answer.ok === false) { if (retry(`the builder stopped before it finished (${oneLine(answer && answer.reason, 80) || 'no answer'})${builderSaid ? `. it said: ${builderSaid}` : ''}`)) return result; continue; }
      const parsed = lastJson(answer.stdout, (v) => typeof v.summary === 'string' || Array.isArray(v.test_files));
      if (parsed) { summary = oneLine(parsed.summary, 300); declared = Array.isArray(parsed.test_files) ? parsed.test_files : []; }
    }
    if (!branchOk()) return fail('the builder committed or switched branches on its own');
    const changes = changedPaths(wt);
    lastRun = null;
    if (!changes.length) { if (retry(`the builder changed nothing${builderSaid ? `. it said: ${builderSaid}` : ''}`)) return result; continue; }
    files = [...new Set(changes.map((c) => c.path))];
    const declaredSet = new Set(declared.filter((p) => typeof p === 'string'));
    tests = files.filter((f) => isTestFile(f) || declaredSet.has(f));
    src = files.filter((f) => !tests.includes(f));
    if (!tests.length) { if (retry('the builder added no regression test')) return result; continue; }
    if (!src.length) { if (retry('the builder changed only tests and left the code as it was')) return result; continue; }
    if (files.some((f) => audit().sensitiveFile(f))) return fail('the builder changed a key or secrets file that a fix may not touch');
    if (tests.some((f) => headContent(wt, f) !== null && !fs.existsSync(path.join(wt, f)))) return fail('the builder deleted an existing test');
    if (files.includes('package.json') && npmTestScript(headContent(wt, 'package.json')) !== npmTestScript(fs.readFileSync(path.join(wt, 'package.json')))) {
      return fail('the builder changed the test command itself');
    }
    single = singleTestCommand(tests, wt);
    if (!single) { if (retry('sentinel cannot run the new test on its own (it knows node --test, pytest and go test)')) return result; continue; }
    result.files = files;
    result.test_files = tests;
    result.summary = summary;
    const fixed = snapshot(wt, files);
    const keep = new Set(files);
    settle = () => { applySnapshot(wt, fixed); dropArtifacts(wt, keep); };

    log('checking that the new test fails on the original code');
    applySnapshot(wt, new Map(src.map((rel) => [rel, headContent(wt, rel)])));
    const before = runTests(single.cmd);
    settle();
    if (!branchOk()) return fail('a test committed or switched branches while it ran');
    if (before.code === 0) { if (retry('the new test also passes on the original code and does not catch this problem')) return result; continue; }
    if (!realFailure(single.runner, before)) { if (retry('the new test fails on the original code only because something is missing, broken or slow and not because a check failed')) return result; continue; }
    result.proofs.fails_before = true;

    log('running the new test and the full test suite with the fix');
    const alone = runTests(single.cmd);
    settle();
    if (alone.code !== 0) { if (retry('the new test fails with the fix in place')) return result; continue; }
    const after = runTests(testCommand);
    settle();
    if (!branchOk()) return fail('a test committed or switched branches while it ran');
    if (after.code !== 0) { if (retry(after.timedOut ? 'the test suite ran out of time with the fix in place' : 'the test suite fails with the fix in place')) return result; continue; }
    result.proofs.passes_after = true;

    log(`asking ${engines.verifier} to check from source that the attack no longer works`);
    const diff = diffText(wt, files);
    let answer;
    if (isHosted(engines.verifier)) {
      const prompt = checkerPrompt(record, { diff, hosted: true, others, source: hostedSourceBlock(wt, [...new Set([...citedFiles(record), ...files])], new Set([...allowed, ...files.filter((f) => !audit().sensitiveFile(f))]), HOSTED_CHECK_MAX_BYTES / 2) });
      if (Buffer.byteLength(prompt) > HOSTED_CHECK_MAX_BYTES) return fail('the change is too large for the checker on atris models');
      [answer] = await hostedRun([{ engine: engines.verifier, prompt, max_output_tokens: HOSTED_OUTPUT_TOKENS.verifier }]);
    } else {
      answer = await runChecker({ engine: engines.verifier, prompt: checkerPrompt(record, { diff, others }), root: wt, env, timeoutMs: timeouts.check });
    }
    settle();
    const verdict = answer && answer.ok !== false ? lastJson(answer.stdout, (v) => typeof v.verdict === 'string') : null;
    if (!verdict) return fail(`the checker gave no clear answer (${oneLine(answer && answer.reason, 80) || 'unreadable'})`);
    result.checker_reason = oneLine(verdict.reason, 400);
    if (verdict.verdict !== 'fixed') { if (retry(`${engines.verifier} says the attack still works: ${oneLine(verdict.reason, 240) || 'no reason given'}`)) return result; continue; }
    result.proofs.checker_agrees = true;
    break;
    }

    // Last look before the commit: the temp worktree is on the fix branch and
    // nothing moved the branch you started from.
    if (!branchOk()) return fail('the fix branch moved or the temp copy left it before the commit');
    if (refSha(root, `refs/heads/${from}`) !== start) return fail(`${from} moved while the fix ran`);
    git(wt, ['add', '-A', '--', ...files]);
    try {
      git(wt, ['commit', '-q', '-m', commitMessage(record, engines.verifier)]);
    } catch (e) {
      return fail(`the commit was blocked: ${oneLine(e.message, 200)}`);
    }
    made = refSha(wt, 'HEAD');
    if (refSha(root, ref) !== made || refSha(root, `${made}^`) !== start) return fail('the commit did not land on the fix branch as expected');
    if (refSha(root, `refs/heads/${from}`) !== start) return fail(`${from} moved while the fix ran`);
    result.commit = made;
    result.committed = true;
    result.ok = true;
    removeWorktree();
    return result;
  } catch (e) {
    return fail(`the fix stopped: ${oneLine(e.message, 200)}`);
  }
}


// ---------------------------------------------------------------- pr

function githubRemote(root) {
  const url = git(root, ['remote', 'get-url', 'origin'], { allowFail: true });
  if (!url) return null;
  return /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/.test(url) ? url : null;
}

function defaultRun(cmd, args, { cwd }) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: `${r.stderr || ''}${r.error ? r.error.message : ''}` };
}

function prBody(record, verifier) {
  return [
    `Sentinel confirmed a security problem in this repository: ${oneLine(record.title, 200).replace(/[.\s]+$/, '')}.`,
    '',
    'This branch holds the smallest fix plus a regression test.',
    '',
    '- the new test fails on the old code',
    '- the full test suite passes with the fix',
    `- ${verifier} read the fixed source and found the attack no longer works`,
    '',
    'Made by atris sentinel fix. Nothing was merged. Review before merging.',
  ].join('\n');
}

function openPr(root, result, record, { run = defaultRun, verifier }) {
  if (!githubRemote(root)) return { ok: false, reason: 'this repository has no github remote named origin' };
  const push = run('git', ['push', '-u', 'origin', result.branch], { cwd: root });
  if (push.code !== 0) return { ok: false, reason: `could not push ${result.branch}: ${oneLine(push.stderr, 160)}` };
  const title = `Fix: ${oneLine(record.title, 200).replace(/[.\s]+$/, '')}`.slice(0, 100);
  const pr = run('gh', ['pr', 'create', '--base', result.from, '--head', result.branch, '--title', title, '--body', prBody(record, verifier)], { cwd: root });
  if (pr.code !== 0) return { ok: false, pushed: true, reason: `gh could not open the pull request: ${oneLine(pr.stderr, 160)}` };
  const url = (pr.stdout.match(/https:\/\/\S+/) || [])[0] || '';
  return { ok: true, pushed: true, url };
}

// ---------------------------------------------------------------- event

function fixEvent(root, record, result) {
  const events = require('./sentinel-events');
  const repo = events.repoName(root);
  const subject = oneLine(record.title, 80).replace(/[.\s]+$/, '');
  const what = subject ? subject.charAt(0).toLowerCase() + subject.slice(1) : '';
  const title = events.fillPlain('Prepared a fix for {what} on a new branch.', { what: ['word', what, 'a confirmed security problem'] });
  return events.makeEvent({ kind: 'scan_finished', repo, severity: 'info', title, status: 'resolved', fingerprint: events.fingerprint('scan_finished', repo, 'fix', record.fingerprint, result.commit || '') });
}

module.exports = {
  BRANCH_PREFIX,
  HOSTED_CHECK_MAX_BYTES,
  HOSTED_OUTPUT_TOKENS,
  shortId,
  branchFor,
  isHosted,
  git,
  branchExists,
  changedPaths,
  isTestFile,
  detectTestCommand,
  confirmedFindings,
  matchFinding,
  citedFiles,
  builderPrompt,
  toolSaid,
  checkerPrompt,
  copyDependencies,
  dropDependencies,
  cloneCommand,
  resolveFixEngines,
  defaultRunBuilder,
  defaultRunChecker,
  hostedWritable,
  hostedSourceBlock,
  fixOne,
  realFailure,
  openPr,
  fixEvent,
  commitMessage,
};
