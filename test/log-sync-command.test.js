const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { logSyncAtris } = require('../commands/log-sync');

// commands/log-sync.js resolves everything from process.cwd() and reads
// process.argv[4] as the optional date argument. A temp dir plus an argv
// shim keeps the sync fully local: every test below stops before any
// network call (missing folder, bad date, or no agent configured).
function makeSandbox(t, { withAtrisDir = true, dateArg } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-log-sync-'));
  if (withAtrisDir) {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  }

  const origCwd = process.cwd();
  const origLog = console.log;
  const origArgv4 = process.argv[4];

  const lines = [];

  process.chdir(root);
  console.log = (...args) => lines.push(args.join(' '));
  if (dateArg === undefined) {
    delete process.argv[4];
  } else {
    process.argv[4] = dateArg;
  }

  t.after(() => {
    console.log = origLog;
    process.chdir(origCwd);
    if (origArgv4 === undefined) {
      delete process.argv[4];
    } else {
      process.argv[4] = origArgv4;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, lines };
}

test('logSyncAtris throws when the atris/ folder is missing', async (t) => {
  makeSandbox(t, { withAtrisDir: false });

  await assert.rejects(
    () => logSyncAtris(),
    /atris\/ folder not found\. Run "atris init" first\./
  );
});

test('logSyncAtris rejects an unparseable --date argument', async (t) => {
  const { root } = makeSandbox(t, { dateArg: '--date=not-a-date' });

  await assert.rejects(
    () => logSyncAtris(),
    /Invalid date provided: not-a-date/
  );

  // The date check must run before any logs/ directory is created.
  assert.strictEqual(fs.existsSync(path.join(root, 'atris', 'logs')), false);
});

test('logSyncAtris creates the local log file, then fails without an agent', async (t) => {
  const { root, lines } = makeSandbox(t, { dateArg: '2020-01-15' });

  await assert.rejects(
    () => logSyncAtris(),
    /No agent selected\. Run "atris agent" first\./
  );

  // Before the credential check, the command scaffolds the daily log.
  const logFile = path.join(root, 'atris', 'logs', '2020', '2020-01-15.md');
  assert.strictEqual(fs.existsSync(logFile), true);
  assert.ok(fs.readFileSync(logFile, 'utf8').length > 0);
  assert.ok(lines.some((line) => line.includes('2020-01-15')));
});
