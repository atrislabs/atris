const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../commands/site');

async function capture(fn) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { code: await fn(), out: lines.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test('site with no args prints usage and returns 2', async () => {
  const { code, out } = await capture(() => run([]));
  assert.equal(code, 2);
  assert.match(out, /atris site/);
  assert.match(out, /--theme/);
});

test('site help and --help print usage and return 0', async () => {
  for (const argv of [['help'], ['--help']]) {
    const { code, out } = await capture(() => run(argv));
    assert.equal(code, 0, `expected 0 for ${JSON.stringify(argv)}`);
    assert.match(out, /atris site/);
  }
});

test('site on a missing path reports the error and returns 2', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-site-'));
  const missing = path.join(dir, 'does-not-exist');
  const { code, out } = await capture(() => run([missing]));
  assert.equal(code, 2);
  assert.ok(out.trim().length > 0, 'expected an error message');
});

test('site builds real pages from a markdown dir into --out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-site-'));
  const src = path.join(dir, 'docs');
  const outDir = path.join(dir, 'public');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'alpha.md'), '# Alpha\n\nfirst page body\n');
  fs.writeFileSync(path.join(src, 'beta.md'), '# Beta\n\nsecond page body\n');

  const { code, out } = await capture(() =>
    run([src, '--out', outDir, '--title', 'Test Site'])
  );
  assert.equal(code, 0);
  assert.match(out, /2 pages \+ index/);
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')));
  assert.ok(fs.existsSync(path.join(outDir, 'alpha.html')));
  assert.ok(fs.existsSync(path.join(outDir, 'beta.html')));
});
