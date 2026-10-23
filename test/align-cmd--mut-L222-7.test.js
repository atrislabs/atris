'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-align-cmd-mut-L222-7-'));
const saved = {
  HOME: process.env.HOME,
  ATRIS_TOKEN: process.env.ATRIS_TOKEN,
  argv: process.argv,
  cwd: process.cwd(),
  request: https.request,
  log: console.log,
  error: console.error,
  write: process.stdout.write,
  exit: process.exit,
};
const savedAtris = {};
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    savedAtris[key] = process.env[key];
    delete process.env[key];
  }
}

process.env.HOME = root;
process.env.ATRIS_TOKEN = 'align-mut-token';

const slug = 'northwind';
const businessName = 'Northwind Goods';
const work = path.join(root, 'work');
fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.atris', 'businesses.json'),
  JSON.stringify({
    [slug]: {
      business_id: 'biz-1',
      workspace_id: 'ws-1',
      name: businessName,
      slug,
    },
  })
);
fs.mkdirSync(path.join(work, '.atris'), { recursive: true });
fs.writeFileSync(
  path.join(work, '.atris', 'business.json'),
  JSON.stringify({ slug })
);

const { alignAtris } = require('../commands/align');

function replyFor(requestPath) {
  if (requestPath.includes('/ai-computer/status')) {
    return { status: 200, body: { status: 'running', endpoint: 'https://cloud.example.test' } };
  }
  if (requestPath.includes('/files')) {
    return { status: 200, body: { files: [] } };
  }
  return { status: 500, body: { detail: 'business list unavailable' } };
}

function installTransport() {
  https.request = (options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => req;
    req.setHeader = () => {};
    req.hasHeader = () => false;
    req.write = () => true;
    req.end = () => {
      const reply = replyFor(String(options && options.path || ''));
      const res = new EventEmitter();
      res.statusCode = reply.status;
      res.headers = {};
      queueMicrotask(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(reply.body)));
        res.emit('end');
        req.emit('close');
      });
    };
    return req;
  };
}

test('cached business name is kept when the business list is unavailable', async () => {
  installTransport();
  const logs = [];
  const errors = [];
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { errors.push(args.join(' ')); };
  process.stdout.write = () => true;
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code === undefined ? 0 : code;
    throw new Error('exit ' + exitCode);
  };
  process.argv = ['node', 'atris', 'align', slug, '--fix', '--hard'];
  process.chdir(work);
  const localDir = process.cwd();
  try {
    await alignAtris();
  } catch (err) {
    if (exitCode === null) throw err;
  }
  assert.equal(exitCode, null);
  assert.deepEqual(errors, []);
  assert.deepEqual(logs, [
    '',
    'Aligning northwind...',
    '  Local:  ' + localDir,
    '  Cloud:  https://cloud.example.test',
    '  Mode:   --hard (force-push: wipe cloud cruft, upload local)',
    '0 entries',
    '  No cloud-only top-level entries to delete.',
    '  Pushing 0 local files to cloud...',
    '',
    '  Force-push complete: 0/0 pushed, 0 cloud-only entries deleted.',
    '  Northwind Goods is now mirrored from local.',
  ]);
});

test.after(() => {
  https.request = saved.request;
  console.log = saved.log;
  console.error = saved.error;
  process.stdout.write = saved.write;
  process.exit = saved.exit;
  process.argv = saved.argv;
  try { process.chdir(saved.cwd); } catch {}
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_') && !Object.prototype.hasOwnProperty.call(savedAtris, key)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(savedAtris)) {
    process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
