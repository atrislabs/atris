// Run the real follower with the lifetime limit used by the board checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'test/member-board.test.js'), 'utf8');
const declaration = source.match(/const FOLLOW_PROCESS_LIMIT = (\{[^\n]+\});/);
assert.ok(declaration, 'the follow checks declare their lifetime limit');
const limits = vm.runInNewContext(`(${declaration[1]})`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-follow-deadline-'));
fs.writeFileSync(path.join(dir, 'builder.log'), `${new Date().toISOString()} m-1 started: check cleanup\n`);
console.log('command: node bin/atris.js member board --json --follow');
console.log(`child lifetime: ${limits.timeout}ms; final signal: ${limits.killSignal}`);
const start = Date.now();
const child = spawn(process.execPath, [path.join(root, 'bin/atris.js'), 'member', 'board', '--json', '--follow'], {
  ...limits, cwd: dir, env: { ...process.env, ATRIS_PROGRESS_DIR: dir },
});
let output = '';
let stopped = false;
child.stdout.on('data', (chunk) => {
  output += chunk;
  if (!stopped && output.includes('\n')) {
    assert.equal(JSON.parse(output.split('\n')[0]).kind, 'snapshot');
    console.log('snapshot received; suspend the child so it cannot handle ctrl-c');
    stopped = child.kill('SIGSTOP');
    child.kill('SIGINT');
  }
});
child.stderr.pipe(process.stderr);
child.on('error', (error) => { throw error; });
child.on('close', (code, signal) => {
  try {
    assert.ok(stopped, 'the actual follower started before being suspended');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    console.log(`child closed: code=${code}, signal=${signal}, elapsed=${Date.now() - start}ms`);
    console.log('proof exit: 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
