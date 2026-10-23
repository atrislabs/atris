'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  parseRepoUrl,
  checkPublicRepo,
  sandboxEnv,
  buildRepoMap,
  renderMapMarkdown,
  renderResultHtml,
  tryRepo,
  createTryServer,
} = require('../lib/try-repo');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

// A small real git repo on disk, so the clone, init, and map run for real
// without the network.
function fixtureRepo() {
  const root = tmp('atris-try-fixture-');
  write(root, 'package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
  write(root, 'README.md', '# demo\n');
  write(root, 'src/index.js', "'use strict';\n\nfunction startServer(port) {\n  return port;\n}\n\nclass Router {}\n\nmodule.exports = { startServer, Router };\n");
  write(root, 'src/util/math.js', 'export function add(a, b) {\n  return a + b;\n}\n');
  write(root, 'tools/build.py', 'import os\n\n\ndef build_all():\n    pass\n');
  write(root, 'test/index.test.js', "require('node:test');\n");
  const env = { ...sandboxEnv(root), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env });
  execFileSync('git', ['add', '.'], { cwd: root, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root, env });
  return root;
}

const publicInfo = async () => ({ status: 200, json: { private: false, size: 10, default_branch: 'main' } });

function sandboxesLeft(tmpRoot) {
  return fs.readdirSync(tmpRoot).filter((name) => name.startsWith('atris-try-'));
}

test('parseRepoUrl accepts the ways people paste a github repo', () => {
  for (const input of [
    'https://github.com/sindresorhus/slash',
    'github.com/sindresorhus/slash',
    'http://www.github.com/sindresorhus/slash.git',
    'git@github.com:sindresorhus/slash.git',
    'sindresorhus/slash',
    'https://github.com/sindresorhus/slash/tree/main/src?tab=readme#top',
    '  github.com/sindresorhus/slash/  ',
  ]) {
    const repo = parseRepoUrl(input);
    assert.equal(repo.slug, 'sindresorhus/slash', input);
    assert.equal(repo.cloneUrl, 'https://github.com/sindresorhus/slash.git');
  }
});

test('parseRepoUrl refuses other hosts and anything that could reach git as a flag', () => {
  const cases = {
    '': 'bad_url',
    'https://gitlab.com/a/b': 'bad_host',
    'https://github.com.evil.com/a/b': 'bad_host',
    'file:///etc/passwd': 'bad_host',
    '--upload-pack=touch/x': 'bad_url',
    'github.com/onlyowner': 'bad_url',
    'a/..': 'bad_url',
    'a/b;rm -rf': 'bad_url',
  };
  for (const [input, code] of Object.entries(cases)) {
    assert.throws(() => parseRepoUrl(input), (error) => error.code === code, input);
  }
});

test('checkPublicRepo refuses private, missing, and oversized repos before cloning', async () => {
  await assert.rejects(checkPublicRepo('a/b', { fetchJson: async () => ({ status: 404, json: {} }) }), { code: 'not_public' });
  await assert.rejects(checkPublicRepo('a/b', { fetchJson: async () => ({ status: 200, json: { private: true } }) }), { code: 'not_public' });
  await assert.rejects(checkPublicRepo('a/b', { fetchJson: async () => ({ status: 200, json: { private: false, size: 300 * 1024 } }) }), { code: 'too_big' });
  assert.equal(await checkPublicRepo('a/b', { fetchJson: async () => ({ status: 403, json: {} }) }), null, 'rate limit falls back to the live caps');
  assert.equal(await checkPublicRepo('a/b', { fetchJson: async () => { throw new Error('offline'); } }), null);
});

test('sandboxEnv carries no host tokens and turns off git credentials', () => {
  process.env.GITHUB_TOKEN = 'secret-token';
  try {
    const env = sandboxEnv('/tmp/x');
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.ok(!Object.values(env).includes('secret-token'));
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_CONFIG_GLOBAL, os.devNull);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test('buildRepoMap finds languages, entry points, tests, and symbols at the right lines', () => {
  const root = fixtureRepo();
  try {
    const map = buildRepoMap(root);
    assert.equal(map.type, 'nodejs');
    assert.equal(map.languages[0].name, 'JavaScript');
    assert.ok(map.languages.some((l) => l.name === 'Python'));
    assert.deepEqual(map.entryPoints, ['src/index.js']);
    assert.equal(map.testFiles, 1);
    const at = (name) => map.symbols.find((s) => s.name === name);
    assert.deepEqual(at('startServer'), { file: 'src/index.js', line: 3, name: 'startServer' });
    assert.deepEqual(at('Router'), { file: 'src/index.js', line: 7, name: 'Router' });
    assert.deepEqual(at('add'), { file: 'src/util/math.js', line: 1, name: 'add' });
    assert.deepEqual(at('build_all'), { file: 'tools/build.py', line: 4, name: 'build_all' });
    assert.ok(!map.symbols.some((s) => s.file.startsWith('test/')), 'test files are not mapped as code');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Found on expressjs/express and pallets/flask: example folders crowded out the
// real entry point, and the first move pointed at the docs or test folder.
test('buildRepoMap keeps examples, docs, and tests out of where to start', () => {
  const root = tmp('atris-try-side-');
  try {
    write(root, 'package.json', '{}');
    write(root, 'index.js', 'function main() {}\n');
    write(root, 'lib/router.js', 'function route() {}\n');
    for (let i = 0; i < 5; i++) write(root, `examples/demo${i}/index.js`, `function demo${i}() {}\n`);
    for (let i = 0; i < 5; i++) write(root, `docs/page${i}.md`, '# page\n');
    for (let i = 0; i < 9; i++) write(root, `test/case${i}.test.js`, '\n');
    write(root, 'test.js', '\n');
    const map = buildRepoMap(root);
    assert.deepEqual(map.entryPoints, ['index.js']);
    assert.ok(!map.symbols.some((s) => s.file.startsWith('examples/')));
    assert.equal(map.testFiles, 10, 'a top-level test.js counts as a test');
    assert.equal(map.codeDirs[0].name, 'lib/');
    const moves = require('../lib/try-repo').nextMoves(map);
    assert.match(moves[0], /lib\//);
    assert.match(renderMapMarkdown(map, { webUrl: 'https://github.com/a/b' }), /project type: nodejs\n/, 'no repeated framework name');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderResultHtml escapes repo content', () => {
  const html = renderResultHtml({
    ok: true,
    repo: { slug: 'a/b' },
    map: { files: 1, testFiles: 0, languages: [{ name: '<script>x</script>', files: 1 }] },
    markdown: '- `<img src=x onerror=alert(1)>`',
    moves: ['<b>one</b>', 'two', 'three'],
    ms: 1200,
  });
  assert.ok(!html.includes('<script>x'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('npm i -g atris'));
  assert.ok(renderResultHtml({ ok: false, error: '<x>', input: '"><svg>' }).includes('&lt;x&gt;'));
});

test('tryRepo clones, runs atris init, maps, and deletes the copy', async () => {
  const source = fixtureRepo();
  const tmpRoot = tmp('atris-try-root-');
  try {
    const result = await tryRepo('github.com/demo/demo', { cloneUrl: source, fetchJson: publicInfo, tmpRoot });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.markdown.includes('`src/index.js:3` `startServer`'));
    assert.equal(result.moves.length, 3);
    assert.ok(result.html.includes('three moves atris would make next'));
    assert.deepEqual(sandboxesLeft(tmpRoot), [], 'throwaway copy is removed');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }), '', 'source repo untouched');
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('tryRepo keeps the copy so atris init output is real, when asked', async () => {
  const source = fixtureRepo();
  const tmpRoot = tmp('atris-try-root-');
  try {
    const result = await tryRepo('demo/demo', { cloneUrl: source, fetchJson: publicInfo, tmpRoot, keep: true });
    assert.equal(result.ok, true, result.error);
    const [sandbox] = sandboxesLeft(tmpRoot);
    const repoDir = path.join(tmpRoot, sandbox, 'repo');
    assert.ok(fs.existsSync(path.join(repoDir, 'atris', 'atris.md')), 'atris init ran in the copy');
    assert.equal(fs.readFileSync(path.join(repoDir, 'atris', 'MAP.md'), 'utf8'), result.markdown);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('tryRepo stops at the size cap and the time cap with a plain reason', async () => {
  const source = fixtureRepo();
  const tmpRoot = tmp('atris-try-root-');
  try {
    // GitHub's size answer can be missing (rate limit), so the live watch has to hold the cap.
    const rateLimited = async () => ({ status: 403, json: {} });
    const big = await tryRepo('demo/demo', { cloneUrl: source, fetchJson: rateLimited, tmpRoot, maxBytes: 100 });
    assert.equal(big.ok, false);
    assert.equal(big.code, 'too_big');
    assert.match(big.error, /over 1 MB/);
    const slow = await tryRepo('demo/demo', { cloneUrl: source, fetchJson: publicInfo, tmpRoot, timeoutMs: 1 });
    assert.equal(slow.ok, false);
    assert.equal(slow.code, 'timeout');
    assert.deepEqual(sandboxesLeft(tmpRoot), []);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('tryRepo refuses a private repo without cloning', async () => {
  const tmpRoot = tmp('atris-try-root-');
  try {
    const result = await tryRepo('github.com/someone/secret', { fetchJson: async () => ({ status: 404, json: {} }), tmpRoot });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_public');
    assert.deepEqual(sandboxesLeft(tmpRoot), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('try server serves the form, maps a repo, and limits each visitor', async () => {
  let calls = 0;
  const server = createTryServer({ perWindow: 1, run: async (input) => { calls++; return { ok: true, html: `<p>${input}</p>` }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const form = await fetch(`${base}/`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /paste a public github link/);
    const first = await fetch(`${base}/try?repo=a/b`);
    assert.equal(first.status, 200);
    assert.equal(await first.text(), '<p>a/b</p>');
    const second = await fetch(`${base}/try?repo=a/b`);
    assert.equal(second.status, 429);
    assert.equal(calls, 1);
    assert.equal((await fetch(`${base}/try`, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});

test('node lib/try-repo.js starts the page on PORT so a box can host it', async () => {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'try-repo.js')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const base = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`no listen line: ${out}`)), 10_000);
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const hit = out.match(/listening on (http:\/\/\S+)/);
        if (hit) { clearTimeout(timer); resolve(hit[1]); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${out}`)); });
    });
    const form = await fetch(`${base}/`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /paste a public github link/);
    const bad = await fetch(`${base}/try?repo=${encodeURIComponent('gitlab.com/a/b')}`);
    assert.equal(bad.status, 400);
  } finally {
    child.kill();
  }
});

// The real thing: a small public repo from github, mapped inside the 60s cap.
test('tryRepo maps a real small public github repo in under a minute', async (t) => {
  const tmpRoot = tmp('atris-try-root-');
  try {
    const result = await tryRepo('https://github.com/sindresorhus/slash', { tmpRoot });
    if (!result.ok && /could not copy/i.test(result.error) && !(await reachable())) {
      t.skip('github is not reachable from this machine');
      return;
    }
    assert.equal(result.ok, true, result.error);
    assert.ok(result.ms < 60_000, `took ${result.ms}ms`);
    assert.equal(result.map.type, 'nodejs');
    assert.ok(result.markdown.includes('index.js'));
    assert.ok(result.map.symbols.some((s) => s.file === 'index.js' && s.name === 'slash'));
    assert.deepEqual(sandboxesLeft(tmpRoot), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function reachable() {
  return new Promise((resolve) => {
    require('dns').lookup('github.com', (error) => resolve(!error));
  });
}
