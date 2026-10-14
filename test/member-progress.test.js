const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { formatToolStep, appendProgress, reportProgress, shortenLine } = require('../lib/member-progress');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_CALLER_RUNTIME']) delete process.env[name];

const tool = (name, input) => ({ type: 'tool_use', id: `t-${name}`, name, input });

test('formatToolStep turns each tool into one plain line', () => {
  const cwd = '/work/repo';
  assert.equal(formatToolStep(tool('Read', { file_path: '/work/repo/lib/a.js' }), cwd), 'reading lib/a.js');
  assert.equal(formatToolStep(tool('Read', { file_path: '/elsewhere/b.js' }), cwd), 'reading /elsewhere/b.js');
  assert.equal(formatToolStep(tool('Edit', { file_path: '/work/repo/x.md' }), cwd), 'editing x.md');
  assert.equal(formatToolStep(tool('MultiEdit', { file_path: '/work/repo/y.js' }), cwd), 'editing y.js');
  assert.equal(formatToolStep(tool('Write', { file_path: '/work/repo/z/new.js' }), cwd), 'editing z/new.js');
  assert.equal(formatToolStep(tool('Bash', { command: 'npm test\necho done' }), cwd), 'running: npm test');
  const long = 'x'.repeat(100);
  assert.equal(formatToolStep(tool('Bash', { command: long }), cwd), `running: ${'x'.repeat(70)}...`);
  assert.equal(formatToolStep(tool('Grep', { pattern: 'formatToolStep' }), cwd), 'searching for formatToolStep');
  assert.equal(formatToolStep(tool('Glob', { pattern: 'lib/**/*.js' }), cwd), 'finding lib/**/*.js');
  assert.equal(formatToolStep(tool('WebFetch', { url: 'https://x' }), cwd), 'webfetch');
  assert.equal(formatToolStep({ type: 'text', text: 'hi' }, cwd), null);
});

test('formatToolStep treats a symlinked root as inside cwd', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-progress-real-'));
  const link = `${real}-link`;
  try {
    fs.symlinkSync(real, link);
    assert.equal(formatToolStep(tool('Write', { file_path: path.join(link, 'new.js') }), real), 'editing new.js');
  } finally {
    try { fs.unlinkSync(link); } catch {}
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('appendProgress writes to ATRIS_PROGRESS_DIR and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-progress-'));
  const prev = process.env.ATRIS_PROGRESS_DIR;
  try {
    process.env.ATRIS_PROGRESS_DIR = path.join(dir, 'nested');
    appendProgress('growth', 'reading lib/a.js', 'mis-1');
    const text = fs.readFileSync(path.join(dir, 'nested', 'growth.log'), 'utf8');
    assert.match(text, /mis-1 reading lib\/a\.js\n$/);
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    process.env.ATRIS_PROGRESS_DIR = path.join(dir, 'file', 'cannot-be-a-dir');
    assert.doesNotThrow(() => appendProgress('growth', 'x', 'mis-1'));
  } finally {
    if (prev === undefined) delete process.env.ATRIS_PROGRESS_DIR;
    else process.env.ATRIS_PROGRESS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shortenLine caps a started objective at 80 chars and other lines at 100', () => {
  assert.equal(shortenLine(`started: ${'x'.repeat(200)}`), `started: ${'x'.repeat(80)}...`);
  assert.equal(shortenLine(`started: ${'a'.repeat(90)}\nsecond line`), `started: ${'a'.repeat(80)}...`);
  assert.equal(shortenLine(`started: keep this\nsecond line`), 'started: keep this');
  assert.equal(shortenLine('started: short objective'), 'started: short objective');
  assert.equal(shortenLine(`started: ${'x'.repeat(80)}`), `started: ${'x'.repeat(80)}`);
  assert.equal(shortenLine(`reading ${'x'.repeat(200)}`), `reading ${'x'.repeat(92)}...`);
  assert.equal(shortenLine('y'.repeat(100)), 'y'.repeat(100));
  assert.equal(shortenLine('y'.repeat(101)), `${'y'.repeat(100)}...`);
  // The run tag rides in front and does not eat the objective's 80 chars.
  assert.equal(shortenLine(`started: [pid 42 engine claude] ${'x'.repeat(200)}`), `started: [pid 42 engine claude] ${'x'.repeat(80)}...`);
});

test('appendProgress and reportProgress store the short form of long lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-progress-'));
  const prev = process.env.ATRIS_PROGRESS_DIR;
  const writes = [];
  const origWrite = process.stderr.write;
  try {
    process.env.ATRIS_PROGRESS_DIR = dir;
    process.stderr.write = (s) => { writes.push(s); return true; };
    appendProgress('growth', `started: ${'x'.repeat(200)}\nsecond line`, 'mis-1');
    reportProgress('growth', `reading ${'y'.repeat(200)}`, 'mis-1');
    const text = fs.readFileSync(path.join(dir, 'growth.log'), 'utf8');
    assert.match(text, new RegExp(`started: ${'x'.repeat(80)}[.]{3}\n`));
    assert.match(text, new RegExp(`reading ${'y'.repeat(92)}[.]{3}\n$`));
    assert.ok(!text.includes('second line'), text);
    assert.equal(writes.length, 1);
    assert.match(writes[0], new RegExp(`  growth \\d\\d:\\d\\d  reading ${'y'.repeat(92)}[.]{3}\n$`));
  } finally {
    process.stderr.write = origWrite;
    if (prev === undefined) delete process.env.ATRIS_PROGRESS_DIR;
    else process.env.ATRIS_PROGRESS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a claude tick writes live steps to the member progress log', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-progress-run-'));
  try {
    const repo = path.join(base, 'repo');
    const progressDir = path.join(base, 'progress');
    fs.mkdirSync(repo, { recursive: true });
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    // The tick may run in its own checkout, so read a file under the fake's own cwd.
    const toolLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '__CWD__/README.md' } }] },
    }).replace('__CWD__', '%s');
    const partial = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start' } });
    fs.writeFileSync(path.join(bin, 'claude'), [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
      `echo '${partial}'`,
      `printf '${toolLine}\\n' "$(pwd)"`,
      `printf '${toolLine}\\n' "$(pwd)"`,
      'echo \'{"type":"result","is_error":false,"result":"finished bounded work"}\'',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    const env = {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_PROGRESS_DIR: progressDir,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    };
    delete env.ATRIS_RUNNER_PROFILE;
    const run = (args) => spawnSync(process.execPath, [cliPath, ...args], { cwd: repo, encoding: 'utf8', env });
    const git = (a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    git(['init', '-q', '-b', 'master']);
    git(['config', 'user.email', 'test@atris.dev']);
    git(['config', 'user.name', 'test']);
    run(['member', 'create', 'growth']);
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);

    // Live (non-json) member runs inherit stdio, so the step lines reach the terminal.
    const res = run(['member', 'run', 'growth', 'improve onboarding proof', '--minutes', '10', '--max-ticks', '1', '--no-verify']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const log = fs.readFileSync(path.join(progressDir, 'growth.log'), 'utf8');
    // The started line names the engine process so the board can tell if it lives.
    assert.match(log, /started: \[pid \d+ engine claude run [0-9a-f]{16}\] improve onboarding proof/);
    assert.equal((log.match(/reading README\.md/g) || []).length, 1, log);
    assert.match(log, /finished: ok/);
    assert.match(res.stderr, /  growth \d\d:\d\d  reading README\.md/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
