'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BATCH_SIZE, MAX_FILES, run } = require('../commands/site-deploy');

function isolate(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-batch-size-home-'));
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-batch-size-site-'));
  const savedHome = process.env.HOME;
  const savedAtrisEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('ATRIS_')),
  );
  for (const key of Object.keys(savedAtrisEnv)) delete process.env[key];
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    Object.assign(process.env, savedAtrisEnv);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(site, { recursive: true, force: true });
  });
  return { home, site };
}

function fakeApi(calls) {
  return async (url, options) => {
    calls.push({ url, options });
    const status = options.method === 'PUT' ? 200 : 201;
    return { status, body: Buffer.from('{}') };
  };
}

test('BATCH_SIZE is 50, a positive whole number that fits inside the file cap', () => {
  assert.strictEqual(BATCH_SIZE, 50);
  assert.ok(Number.isInteger(BATCH_SIZE));
  assert.ok(BATCH_SIZE > 0);
  assert.ok(BATCH_SIZE <= MAX_FILES, `one batch (${BATCH_SIZE}) must fit under MAX_FILES (${MAX_FILES})`);
});

test('run sends no upload requests when the folder has no publishable files', async (t) => {
  const { home, site } = isolate(t);
  fs.writeFileSync(path.join(site, 'logo.exe'), 'not a web asset');
  const calls = [];

  const code = await run([site, '--name', 'batch-empty', '--yes'], {
    fs,
    homedir: () => home,
    httpRequest: fakeApi(calls),
    loadCredentials: () => ({ token: 'test-token' }),
    log: () => {},
    error: () => {},
  });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(calls.map((call) => call.options.method), ['POST']);
});

test('run splits pages into BATCH_SIZE chunks and keeps a short final chunk', async (t) => {
  const { home, site } = isolate(t);
  const fileCount = BATCH_SIZE + 1;
  for (let i = 0; i < fileCount; i += 1) {
    fs.writeFileSync(path.join(site, `page-${String(i).padStart(2, '0')}.txt`), 'x');
  }
  const calls = [];

  const code = await run([site, '--name', 'batch-split', '--yes'], {
    fs,
    homedir: () => home,
    httpRequest: fakeApi(calls),
    loadCredentials: () => ({ token: 'test-token' }),
    log: () => {},
    error: () => {},
  });

  assert.strictEqual(code, 0);
  const puts = calls.filter((call) => call.options.method === 'PUT');
  const chunkSizes = puts.map((call) => JSON.parse(call.options.body).length);
  assert.deepStrictEqual(chunkSizes, [BATCH_SIZE, 1]);

  const uploadedPaths = puts.flatMap((call) => JSON.parse(call.options.body).map((page) => page.path));
  assert.strictEqual(uploadedPaths.length, fileCount);
  assert.strictEqual(uploadedPaths[0], 'page-00.txt');
  assert.strictEqual(uploadedPaths[fileCount - 1], `page-${String(fileCount - 1).padStart(2, '0')}.txt`);
});
