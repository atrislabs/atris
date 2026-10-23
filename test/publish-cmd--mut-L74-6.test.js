const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('publishing omits oversized files from the upload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-large-upload-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  let api;
  let savedRequest;
  let uploadedFiles;
  try {
    process.env.HOME = root;
    process.env.ATRIS_TEST_STATE_DIR = root;
    process.env.ATRIS_TOKEN = 'test-token';
    process.chdir(root);
    process.argv = ['node', 'atris', 'publish', '--name', 'large-file-check'];
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'notes.md'), 'small document');
    fs.writeFileSync(path.join(root, 'atris', 'large.txt'), 'x'.repeat(700 * 1024));
    api = require('../utils/api');
    savedRequest = api.apiRequestJson;
    api.apiRequestJson = async (_pathname, options) => {
      uploadedFiles = options.body.files;
      return { ok: true, status: 200, data: {} };
    };
    const { publishAtris } = require('../commands/publish');
    await publishAtris();
    assert.strictEqual(uploadedFiles.some((file) => file.path === '/large.txt'), false);
  } finally {
    if (api) api.apiRequestJson = savedRequest;
    process.chdir(savedCwd);
    process.argv = savedArgv;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
