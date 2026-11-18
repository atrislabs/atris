'use strict';

// spends: nothing (stand-in init, member creation and git; no model, no network)
//
// One side of a race in test/feed-setup.test.js: `setup` or `start` on one
// folder, with stand-ins that log every call to a shared file and hold the
// slow steps open a moment, so two processes really overlap.

const fs = require('node:fs');
const path = require('node:path');

const [mode, folder, logFile] = process.argv.slice(2);
// The full test run starts every file under test/ on its own, with no
// arguments; that run has nothing to do here.
if (!mode || !folder || !logFile) process.exit(0);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (line) => fs.appendFileSync(logFile, `${mode} ${line}\n`);

const runCli = (cwd, args) => {
  log(args.slice(0, 3).join(' '));
  if (args[0] === 'init') {
    pause(300);
    fs.mkdirSync(path.join(cwd, 'atris', 'team'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'atris', 'atris.md'), '# atris\n');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# written by atris\n');
  } else if (args[0] === 'member' && args[1] === 'create') {
    pause(100);
    const name = args[2];
    fs.mkdirSync(path.join(cwd, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\n---\n`);
  }
  return { ok: true, status: 0, stdout: '', stderr: '' };
};
const deps = {
  runCli,
  git: (_cwd, args) => { log(`git ${args.includes('commit') ? 'commit' : args[0]}`); return { status: 0 }; },
  spawnRunner: () => process.pid,
  spawnThinker: () => { log('think'); return null; },
  isAlive: () => true,
  lowPower: () => false,
  board: () => {},
};

(async () => {
  // setup-die: killed the moment the last teammate joined, before the read.
  const onStep = mode === 'setup-die' ? (event) => { if (event.kind === 'join' && event.member === 'builder') process.exit(9); } : undefined;
  const out = mode.startsWith('setup')
    ? await require('../../lib/feed-setup').setup(folder, { env: process.env, deps, onStep })
    : await require('../../lib/feed-team').start(folder, { env: process.env, deps });
  process.stdout.write(JSON.stringify({ created: out.created || out.joined || [] }));
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(1);
});
