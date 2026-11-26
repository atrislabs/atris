'use strict';

// The rendered page check. The probe copy and the reading of a dumped page are checked with
// canned strings. They run anywhere. The browser tests open tiny pages in a real headless
// browser and skip, saying why, on a machine with none.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderCheck, findBrowser, injectProbe, readDump } = require('../lib/page-render');

test('the probe copy keeps the doctype first, loads files from the page folder and ends with the probe', () => {
  const out = injectProbe('<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>', '/pages/site', {});
  assert.match(out, /^<!doctype html><html><head><base data-atris-probe href="file:\/\/\/pages\/site\/"><title>/);
  assert.match(out, /<script data-atris-probe>\(function probe[\s\S]*<\/script>$/);
  // a page with its own base keeps it
  assert.doesNotMatch(injectProbe('<base href="https://x.test/"><main></main>', '/p', {}), /<base data-atris-probe/);
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
});

const BROWSER = findBrowser();
const skip = BROWSER ? false : 'no browser found on this computer; install Chrome or set CHROME_PATH to run it';

function page(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-render-test-'));
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

test('a clean page passes every rule at both widths', { skip }, async () => {
  const r = await check('<main><h1>Plans</h1><p>Two plans. Pick the one that fits how many people use it.</p></main>');
  assert.equal(r.ran, true, r.reason);
  assert.deepEqual(r.findings, []);
  assert.equal(r.results.length, 7);
});
