'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_PAGE_BYTES,
  MAX_PAGES,
  collectPages,
  normalizePagePath,
  run,
} = require('../lib/site-publish');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-site-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

test('collectPages walks files, maps content types, and encodes binary assets', (t) => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>');
  fs.writeFileSync(path.join(dir, 'assets', 'app.css'), 'body {}');
  fs.writeFileSync(path.join(dir, 'assets', 'pixel.png'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(dir, 'asset.custom'), Buffer.from([3, 4]));
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'ignored');
  fs.writeFileSync(path.join(dir, '.secret'), 'ignored');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'ignored');

  const pages = collectPages(dir);
  assert.deepEqual(pages.map((page) => page.path), [
    'asset.custom',
    'assets/app.css',
    'assets/pixel.png',
    'index.html',
  ]);
  assert.ok(pages.every((page) => !page.path.startsWith('/')));

  const html = pages.find((page) => page.path === 'index.html');
  assert.deepEqual(html, {
    path: 'index.html',
    content: '<h1>hello</h1>',
    content_type: 'text/html; charset=utf-8',
    is_base64: false,
  });

  const css = pages.find((page) => page.path === 'assets/app.css');
  assert.equal(css.content_type, 'text/css; charset=utf-8');
  assert.equal(css.is_base64, false);

  const png = pages.find((page) => page.path === 'assets/pixel.png');
  assert.equal(png.content_type, 'image/png');
  assert.equal(png.content, Buffer.from([0, 1, 2]).toString('base64'));
  assert.equal(png.is_base64, true);

  const unknown = pages.find((page) => page.path === 'asset.custom');
  assert.equal(unknown.content_type, 'application/octet-stream');
  assert.equal(unknown.is_base64, true);
});

test('collectPages rejects pages over 2 mb and names every offender', (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), 'hello');
  fs.writeFileSync(path.join(dir, 'large-one.bin'), Buffer.alloc(MAX_PAGE_BYTES + 1));
  fs.writeFileSync(path.join(dir, 'large-two.bin'), Buffer.alloc(MAX_PAGE_BYTES + 2));

  assert.throws(
    () => collectPages(dir),
    (error) => error.message.includes('pages over 2 mb')
      && error.message.includes('large-one.bin')
      && error.message.includes('large-two.bin'),
  );
});

test('collectPages rejects more than 200 pages and names excess paths', (t) => {
  const dir = scratch(t);
  for (let i = 0; i <= MAX_PAGES; i += 1) {
    fs.writeFileSync(path.join(dir, `page-${String(i).padStart(3, '0')}.txt`), 'x');
  }

  assert.throws(
    () => collectPages(dir),
    (error) => error.message.includes('pages over the 200 page limit')
      && error.message.includes('page-200.txt'),
  );
});

test('normalizePagePath removes a leading slash and uses web separators', () => {
  assert.equal(normalizePagePath('/assets\\nested\\app.js'), 'assets/nested/app.js');
});

test('run requires --slug before loading credentials or calling fetch', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), 'hello');
  const errors = [];
  let credentialsLoaded = false;
  let requested = false;

  const code = await run([dir], {
    loadCredentials: () => { credentialsLoaded = true; return { token: 'test-token' }; },
    fetch: async () => { requested = true; return jsonResponse(200, {}); },
    error: (line) => errors.push(line),
  });

  assert.equal(code, 2);
  assert.deepEqual(errors, ['--slug is required']);
  assert.equal(credentialsLoaded, false);
  assert.equal(requested, false);
});

test('run posts the exact publish body with an injected fetch function', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hi")');
  const calls = [];
  const logs = [];

  const response = {
    publish_id: 'pub-next',
    previous_publish_id: 'pub-prev',
    slug: 'shape-test',
    pages: 2,
    verified: true,
    urls: {
      site: 'https://shape-test.atris.ai/',
      app: 'https://atris.ai/sites/shape-test',
      preview: 'https://preview.atris.ai/pub-next',
    },
  };

  const code = await run([
    dir,
    '--slug', 'shape-test',
    '--profile', 'app',
    '--spa',
    '--no-claim',
  ], {
    apiBase: 'http://localhost:9876/api',
    loadCredentials: () => ({ token: 'test-token' }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, response);
    },
    log: (line) => logs.push(line),
    error: (line) => logs.push(line),
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:9876/api/sites/shape-test/publish');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    pages: [
      {
        path: 'app.js',
        content: 'console.log("hi")',
        content_type: 'text/javascript; charset=utf-8',
        is_base64: false,
      },
      {
        path: 'index.html',
        content: '<h1>hello</h1>',
        content_type: 'text/html; charset=utf-8',
        is_base64: false,
      },
    ],
    claim_subdomain: false,
    spa: true,
    csp_profile: 'app',
  });
  assert.ok(logs.includes('pages uploaded: 2'));
  assert.ok(logs.includes('verified: yes'));
  assert.ok(logs.includes('site url: https://shape-test.atris.ai/'));
  assert.ok(logs.includes('preview url: https://preview.atris.ai/pub-next'));
  assert.ok(logs.includes('publish id: pub-next'));
});

test('run returns a non-zero code when the API does not verify the publish', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), 'hello');
  const errors = [];
  let requestBody;

  const code = await run([dir, '--slug', 'not-live'], {
    loadCredentials: () => ({ token: 'test-token' }),
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse(200, {
        publish_id: 'pub-unverified',
        pages: 1,
        verified: false,
        urls: { site: 'https://not-live.atris.ai/', preview: 'https://preview.atris.ai/pub-unverified' },
      });
    },
    log: () => {},
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1);
  assert.equal(requestBody.claim_subdomain, true);
  assert.equal(Object.prototype.hasOwnProperty.call(requestBody, 'spa'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(requestBody, 'csp_profile'), false);
  assert.deepEqual(errors, ['site is not live: verified no']);
});

test('run prints the required retry guidance for a missing subdomain grant', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'index.html'), 'hello');
  const errors = [];

  const code = await run([dir, '--slug', 'claim-failed'], {
    loadCredentials: () => ({ token: 'test-token' }),
    fetch: async () => jsonResponse(503, { detail: 'subdomain_grant_unavailable' }),
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(errors, [
    'subdomain_grant_unavailable',
    'could not claim claim-failed.atris.ai (server has no Render credentials); retry with --no-claim if the subdomain already exists',
  ]);
});
