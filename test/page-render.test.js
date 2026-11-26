'use strict';

// The rendered page check. The probe copy and the reading of a dumped page are checked with
// canned strings. They run anywhere. The browser tests open tiny pages in a real headless
// browser and skip, saying why, on a machine with none.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderCheck, injectProbe, readDump } = require('../lib/page-render');
const { findBrowser } = require('../lib/headless-chrome');

test('the probe copy keeps the doctype first, loads files from the page folder and ends with the probe', () => {
  const out = injectProbe('<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>', '/pages/site', {});
  assert.match(out, /^<!doctype html><html><head><base data-atris-probe href="file:\/\/\/pages\/site\/"><title>/);
  assert.match(out, /<script data-atris-probe>\(function probe[\s\S]*<\/script>$/);
  // the page's own base wins where it points, read against the page's folder; the word base in a
  // comment, a script or a custom element is not a base
  assert.match(injectProbe('<base href="https://x.test/"><main></main>', '/p', {}), /<base data-atris-probe href="https:\/\/x\.test\/">/);
  assert.match(injectProbe('<head><base href="assets/"></head><main></main>', '/p', {}), /<base data-atris-probe href="file:\/\/\/p\/assets\/">/);
  for (const html of ['<!-- no <base> here --><main></main>', '<script>var x = "<base";</script>', '<base-card>x</base-card>', '<base target="_blank">']) {
    assert.match(injectProbe(html, '/p', {}), /<base data-atris-probe href="file:\/\/\/p\/">/, html);
  }
});

// Every folder a test makes is removed when the run ends: on a pass, a failed assert, process.exit
// or a signal, which is turned into process.exit so the exit hook runs.
const made = [];
function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
const cleanup = () => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); };
test.after(cleanup);
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGHUP' ? 129 : 143));

test('an interrupted check stops the browser it started and removes its profile', { skip: process.platform === 'win32' ? 'the stand-in browser is a shell script' : false }, async () => {
  // a browser that never ends: the check is interrupted while it waits
  const sleeper = path.join(temp('page-render-sleep-'), 'chrome');
  fs.writeFileSync(sleeper, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  const { spawnSync } = require('node:child_process');
  const script = `process.env.CHROME_PATH = ${JSON.stringify(sleeper)}; require(${JSON.stringify(require.resolve('../lib/page-render'))}).renderCheck(${JSON.stringify(__filename)}, { widths: [1280] }); setTimeout(() => process.kill(process.pid, 'SIGINT'), 500);`;
  const tmp = temp('page-render-tmp-');
  const run = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TMPDIR: tmp }, timeout: 20000 });
  assert.equal(run.status, 130);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('atris-render-')), []);
});

test('the owner sets how long the browser may take. a browser past it is stopped with the setting named', { skip: process.platform === 'win32' ? 'the stand-in browser is a shell script' : false }, async () => {
  const dir = temp('page-render-wait-');
  const sleeper = path.join(dir, 'chrome');
  fs.writeFileSync(sleeper, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, '.atris'));
  fs.writeFileSync(path.join(dir, '.atris', 'slop.rules.json'), JSON.stringify({ renderSeconds: 1.5 }));
  const started = Date.now();
  const r = await renderCheck(__filename, { widths: [1280], root: dir, env: { CHROME_PATH: sleeper } });
  assert.ok(Date.now() - started < 10000);
  assert.equal(r.reason, 'the browser did not finish within 1.5 seconds at 1280px. a slow machine can wait longer with "renderSeconds" in .atris/slop.rules.json');
});

test('reading a dumped page returns the measurements and the page without the probe', () => {
  const page = '<html><head><base data-atris-probe="" href="file:///p/"></head><body><main>Hi</main><script data-atris-probe="">probe()</script></body></html>';
  const json = JSON.stringify({ res: { vw: 390, overflow: [] }, dom: page }).replace(/</g, '\\u003c');
  const got = readDump(`<html><body><iframe></iframe><script type="application/json" id="atris-render-probe">${json}</script></body></html>`);
  assert.deepEqual(got.probed, { vw: 390, overflow: [] });
  assert.equal(got.page, '<html><head></head><body><main>Hi</main></body></html>');
  assert.equal(readDump('<html><body></body></html>').probed, null);
});

test('the browser finder honours CHROME_PATH and finds nothing on an empty computer', () => {
  assert.equal(findBrowser({ CHROME_PATH: __filename }, 'linux'), __filename);
  assert.equal(findBrowser({ PATH: '' }, 'linux'), null);
  // atris card and atris reel found a browser named chrome on the PATH before they shared this finder
  const bin = temp('page-render-path-');
  fs.writeFileSync(path.join(bin, 'chrome'), '');
  assert.equal(findBrowser({ PATH: bin }, 'linux'), path.join(bin, 'chrome'));
});

test('with no browser the check says what to install', async () => {
  const r = await renderCheck(__filename, { env: { PATH: '' }, platform: 'linux' });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'no browser found on this computer. install Chrome, Chromium, Edge or Brave, or set CHROME_PATH');
});

const BROWSER = findBrowser();
const skip = BROWSER ? false : 'no browser found on this computer; install Chrome, Chromium, Edge or Brave, or set CHROME_PATH to run it';

function page(html) {
  const dir = temp('page-render-test-');
  fs.writeFileSync(path.join(dir, 'page.html'), html);
  return { file: path.join(dir, 'page.html'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function check(html) {
  const p = page(html);
  try { return await renderCheck(p.file, { widths: [390, 1280] }); } finally { p.done(); }
}
const failed = (r) => r.results.filter((x) => x.ok === false).map((x) => x.id);

test('a row wider than a phone overflows at 390 only', { skip }, async () => {
  const r = await check('<main><h1>Plans</h1><div style="width:900px">One row of plan names.</div></main>');
  assert.equal(r.ran, true, r.reason);
  assert.deepEqual(failed(r), ['render-overflow']);
  assert.deepEqual(r.findings.map((f) => f.width), [390]);
  assert.match(r.findings[0].why, /Seen at 390 and 1280 pixels wide/);
});

test('a word a script writes into the page is caught once rendered', { skip }, async () => {
  const r = await check('<main><h1>Plans</h1><p id="x"></p><script>x.textContent = "We quietly keep your files safe for you."</script></main>');
  assert.equal(r.ran, true, r.reason);
  assert.deepEqual(failed(r), ['render-page-rules']);
  assert.ok(r.findings.some((f) => /page-word-quiet/.test(f.text)), r.findings.map((f) => f.text).join('\n'));
});

test('a form page built in plain passes at both widths', { skip }, async () => {
  const { compilePage } = require('../lib/page-lang');
  const form = '<main>\n<header><h1>Sign up</h1></header>\n<form>\n<label for="e">Email</label>\n<input id="e" type="email">\n<button type="submit">Create account</button>\n<output>That email did not work.</output>\n</form>\n</main>\n';
  const r = await check(compilePage(form));
  assert.equal(r.ran, true, r.reason);
  assert.deepEqual(r.findings.map((f) => f.text), []);
});

test('a clean page passes every rule at both widths', { skip }, async () => {
  const r = await check('<main><h1>Plans</h1><p>Two plans. Pick the one that fits how many people use it.</p></main>');
  assert.equal(r.ran, true, r.reason);
  assert.deepEqual(r.findings, []);
  assert.equal(r.results.length, 7);
});
