// A fleet build worktree is ephemeral. If a process inside one runs `npm link`,
// the global `atris` symlink is repointed at that worktree; when teardown
// removes the worktree the global CLI becomes a dangling symlink and every
// cron, loop, and mission dies with 'command not found' (found live 2026-07-26,
// CLI-1193). Teardown must never leave the global CLI linked to a worktree:
// detect the hijack, repoint at the primary checkout, and verify the CLI runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fleet = require('../lib/fleet');

test('guardGlobalCliLink leaves a healthy global link untouched', () => {
  let repointed = false;
  const result = fleet.guardGlobalCliLink({
    worktreePaths: ['/wt/fleet-a', '/wt/fleet-b'],
    readGlobalLink: () => ({ path: '/usr/lib/node_modules/atris', target: '/Users/dev/atris-cli' }),
    repointLink: () => { repointed = true; return { status: 0 }; },
    verifyCli: () => ({ ok: true }),
  });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'healthy');
  assert.equal(repointed, false, 'a healthy link must not be repointed');
});

test('guardGlobalCliLink is a no-op when atris is not globally linked', () => {
  let repointed = false;
  const result = fleet.guardGlobalCliLink({
    worktreePaths: ['/wt/fleet-a'],
    readGlobalLink: () => null,
    repointLink: () => { repointed = true; return { status: 0 }; },
    verifyCli: () => ({ ok: true }),
  });
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'not_linked');
  assert.equal(repointed, false);
});

test('guardGlobalCliLink repoints a link that a flight worktree hijacked and verifies the CLI runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cli-link-'));
  try {
    const worktree = '/some/.agent-worktrees/atris-cli/fleet-cli-1188';
    const repointedTo = [];
    let verified = false;
    const result = fleet.guardGlobalCliLink({
      root,
      worktreePaths: [worktree],
      // the global symlink points INSIDE the ephemeral worktree
      readGlobalLink: () => ({ path: '/opt/homebrew/lib/node_modules/atris', target: `${worktree}` }),
      repointLink: (primary) => { repointedTo.push(primary); return { status: 0 }; },
      verifyCli: () => { verified = true; return { ok: true, status: 0, stdout: '3.38.0' }; },
    });
    assert.equal(result.changed, true);
    assert.equal(result.reason, 'linked_into_worktree');
    assert.equal(result.ok, true);
    assert.equal(result.was, worktree);
    // restored at the primary checkout (this test root is its own primary worktree)
    assert.equal(repointedTo.length, 1);
    assert.equal(result.restoredTo, repointedTo[0]);
    assert.equal(verified, true, 'teardown must verify the CLI still runs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('guardGlobalCliLink matches a nested path under a flight worktree', () => {
  const worktree = '/tmp/.agent-worktrees/atris-cli/fleet-cli-9';
  const result = fleet.guardGlobalCliLink({
    worktreePaths: [worktree],
    readGlobalLink: () => ({ path: '/g/atris', target: `${worktree}/lib` }),
    repointLink: () => ({ status: 0 }),
    verifyCli: () => ({ ok: true }),
  });
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'linked_into_worktree');
});

test('guardGlobalCliLink reports failure when the CLI still will not run after repoint', () => {
  const worktree = '/tmp/wt/fleet-x';
  const result = fleet.guardGlobalCliLink({
    worktreePaths: [worktree],
    readGlobalLink: () => ({ path: '/g/atris', target: worktree }),
    repointLink: () => ({ status: 0 }),
    verifyCli: () => ({ ok: false, status: 127 }),
  });
  assert.equal(result.changed, true);
  assert.equal(result.ok, false, 'teardown must not report success if the CLI is still broken');
});

test('runFleetFlight runs the teardown CLI-link guard over its own worktrees and records the result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cli-link-flight-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    const ownCli = (args) => {
      if (args[0] === 'worktree' && args[1] === 'start') {
        return { status: 0, stdout: `next: cd ${root}/wt-1\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    const guardCalls = [];
    const flight = await fleet.runFleetFlight({
      root,
      engines: ['codex'],
      log: () => {},
      ownCli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
      lander: () => ({ ok: true, stage: 'shipped' }),
      guardCliLink: (opts) => { guardCalls.push(opts); return { ok: true, changed: false, reason: 'not_linked' }; },
    });
    assert.equal(guardCalls.length, 1, 'teardown must run the CLI-link guard exactly once');
    assert.deepEqual(guardCalls[0].worktreePaths, [`${root}/wt-1`]);
    assert.deepEqual(flight.cli_link, { ok: true, changed: false, reason: 'not_linked' });
    // the guard result rides the persisted receipt
    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.deepEqual(receipt.cli_link, { ok: true, changed: false, reason: 'not_linked' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
