const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { radarCommand } = require('../commands/radar');

const NOW_MS = Date.parse('2026-10-23T12:00:00.000Z');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-radar-cmd-'));
const home = path.join(sandbox, 'home');
fs.mkdirSync(home, { recursive: true });

const savedEnv = {};
for (const key of Object.keys(process.env)) {
  if (key === 'HOME' || key.startsWith('ATRIS_')) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
process.env.HOME = home;

test.after(() => {
  for (const key of Object.keys(process.env)) {
    if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let counter = 0;
function makeRoot(files = {}) {
  counter += 1;
  const root = path.join(sandbox, `ws-${counter}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

function fakeExec({ ps, worktrees = '', branch = 'feature/x' } = {}) {
  return (cmd, args) => {
    if (cmd === 'ps') {
      if (ps instanceof Error) throw ps;
      return ps || '';
    }
    if (cmd === 'git') {
      if (args.includes('worktree')) return worktrees;
      if (args.includes('status')) return ' M a.js\n?? b.js\n';
      if (args.includes('branch')) return `${branch}\n`;
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

function run(args, options) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  let code;
  try {
    code = radarCommand(args, { platform: 'linux', homeDir: home, nowMs: NOW_MS, ...options });
  } finally {
    console.log = original;
  }
  return { code, out: lines.join('\n') };
}

test('help flags print usage and never scan processes', () => {
  const exec = () => { throw new Error('help must not spawn anything'); };
  for (const args of [['--help'], ['-h'], ['help'], ['--json', '--help']]) {
    const { code, out } = run(args, { execFileSync: exec, root: sandbox });
    assert.strictEqual(code, 0);
    assert.match(out, /^Usage: atris radar \[--json\] \[--agents\] \[--global\]/);
    assert.match(out, /Usage: atris ctop/);
    assert.match(out, /Default scope is this workspace/);
  }
});

test('empty workspace with no agents renders a quiet text report', () => {
  const root = makeRoot();
  const { code, out } = run([], { root, execFileSync: fakeExec({ ps: new Error('ps missing') }) });
  assert.strictEqual(code, 0);
  assert.match(out, /^Operator radar\nScope: workspace \(this workspace\)/);
  assert.match(out, /^Agents: 0\/0 active$/m);
  assert.match(out, /^Tasks: 0 open, 0 claimed, 0 review \(0 certified\)$/m);
  assert.match(out, /^Missions: 0 active, 0 paused, 0 stale\/no-verifier$/m);
  assert.match(out, /^Worktrees: 0 registered, 0 dirty$/m);
  assert.match(out, /^Next: repair AgentXP integrity$/m);
  assert.match(out, /^Business: no local business binding$/m);
  assert.match(out, /^AgentXP: 0 total, 0 today, 0 receipts, integrity unknown$/m);
  assert.doesNotMatch(out, /Stale mission candidates|Review queue|Dirty worktrees/);
});

test('--json reports tasks, stale missions, child-process pruning and the fixed timestamp', () => {
  const root = makeRoot({
    '.atris/state/tasks.projection.json': {
      tasks: [
        { display_id: 'CLI-1', title: 'Fix the thing', status: 'claimed', workspace_root: null, claimed_by: 'codex' },
        { display_id: 'CLI-2', title: 'Look at it', status: 'review', metadata: { agent_certified: true } },
      ],
    },
    '.atris/state/missions.jsonl': [
      { id: 'm-old', status: 'running', verifier: 'npm test', last_tick_at: '2026-10-20T00:00:00.000Z', next_action: 'repair it' },
      { id: 'm-new', status: 'running', verifier: 'npm test', last_tick_at: '2026-10-23T00:00:00.000Z' },
      { id: 'm-new', status: 'paused', verifier: 'npm test', last_tick_at: '2026-10-23T00:00:00.000Z' },
    ].map(row => JSON.stringify(row)).join('\n') + '\nnot json\n',
  });
  const ps = [
    '100 1 1.0 0.1 S Mon May 18 12:00:00 2026 /opt/codex/codex exec',
    '101 100 25.5 2.0 S Mon May 18 12:00:01 2026 /opt/codex/codex exec --child',
    'garbage line',
  ].join('\n');
  const { code, out } = run(['--json'], {
    root,
    execFileSync: fakeExec({ ps }),
    readlinkSync: () => root,
  });
  assert.strictEqual(code, 0);
  const data = JSON.parse(out);
  assert.strictEqual(data.scope, 'workspace');
  assert.strictEqual(data.root, root);
  assert.strictEqual(data.generated_at, '2026-10-23T12:00:00.000Z');
  assert.deepStrictEqual(data.tasks.map(t => t.display_id), ['CLI-1', 'CLI-2']);
  assert.deepStrictEqual(data.missions.map(m => [m.id, m.status, m.stale]), [['m-old', 'running', true], ['m-new', 'paused', false]]);
  assert.strictEqual(data.summary.missions.stale, 1);
  assert.strictEqual(data.summary.missions.paused, 1);
  assert.strictEqual(data.summary.tasks.claimed, 1);
  assert.strictEqual(data.summary.tasks.certifiedReview, 1);
  assert.strictEqual(data.next_action, 'work CLI-1: Fix the thing');
  // pid 100 is the parent of pid 101, so only the leaf process is listed
  assert.strictEqual(data.agents.length, 1);
  const agent = data.agents[0];
  assert.strictEqual(agent.pid, '101');
  assert.strictEqual(agent.agent, 'codex');
  assert.strictEqual(agent.status, 'active');
  assert.strictEqual(agent.branch, 'feature/x');
  assert.strictEqual(agent.task, 'CLI-1');
  assert.strictEqual(agent.task_source, 'repo_task_projection');
  assert.strictEqual(agent.owner, 'codex');
});

test('text report lists agents, stale missions and the review queue', () => {
  const root = makeRoot({
    '.atris/state/tasks.projection.json': {
      tasks: [{ display_id: 'CLI-7', title: 'Check the diff', status: 'review', metadata: { agent_review_pass_count: 1 } }],
    },
    '.atris/state/missions.jsonl': JSON.stringify({ id: 'm-stuck', status: 'running', next_action: 'add a verifier' }),
  });
  const ps = '555 1 4.0 1.5 S Mon May 18 12:00:00 2026 /usr/local/bin/opencode run';
  const { out } = run([], { root, execFileSync: fakeExec({ ps }), readlinkSync: () => root });
  assert.match(out, /^Agents: 1\/1 active$/m);
  assert.match(out, /^Tasks: 0 open, 0 claimed, 1 review \(0 certified\)$/m);
  assert.match(out, /^Missions: 1 active, 0 paused, 1 stale\/no-verifier$/m);
  assert.match(out, /^555\s+opencode\s+\S+\s+feature\/x\s+CLI-7\s/m);
  assert.match(out, /Stale mission candidates:\n- m-stuck: add a verifier/);
  assert.match(out, /Review queue:\n- CLI-7 1 pass: Check the diff/);
  assert.match(out, /^Next: review CLI-7: Check the diff$/m);
});

test('--agents --json returns the process payload with untasked reasons and scope filtering', () => {
  const root = makeRoot({ '.atris/state/tasks.projection.json': { tasks: [] } });
  const ps = [
    '200 1 3.0 0.5 S Mon May 18 12:00:00 2026 claude',
    '300 1 0.0 0.1 Z Mon May 18 12:00:00 2026 /usr/bin/opencode',
  ].join('\n');
  const readlinkSync = (link) => {
    if (link === '/proc/200/cwd') return root;
    throw new Error('gone');
  };
  const options = { root, execFileSync: fakeExec({ ps }), readlinkSync };

  const local = JSON.parse(run(['agents', '--json'], options).out);
  assert.strictEqual(local.scope, 'workspace');
  assert.strictEqual(local.generated_at, '2026-10-23T12:00:00.000Z');
  assert.strictEqual(local.summary.total, 1);
  assert.strictEqual(local.summary.untasked, 1);
  assert.deepStrictEqual(local.summary.untasked_reasons, [{ reason: 'interactive session', count: 1 }]);
  assert.strictEqual(local.next_action, 'resolve 1 untasked session: 1 interactive session');
  assert.deepStrictEqual(local.task_load, []);
  assert.strictEqual(local.agents[0].pid, '200');

  const global = JSON.parse(run(['--agents', '--json', '--global'], options).out);
  assert.strictEqual(global.scope, 'global');
  assert.strictEqual(global.summary.total, 2);
  // the zombie sorts after the active session and has no readable cwd
  assert.deepStrictEqual(global.agents.map(a => [a.pid, a.status]), [['200', 'active'], ['300', 'zombie']]);
  assert.strictEqual(global.agents[1].task_reason, 'cwd unknown');
  assert.strictEqual(global.next_action, 'inspect 1 stopped agent session');
});

test('--agents text view renders the process top table', () => {
  const root = makeRoot({ '.atris/state/tasks.projection.json': { tasks: [] } });
  const ps = '200 1 3.0 0.5 S Mon May 18 12:00:00 2026 claude';
  const { code, out } = run(['--agents'], { root, execFileSync: fakeExec({ ps }), readlinkSync: () => root });
  assert.strictEqual(code, 0);
  assert.match(out, /^Agent process top\n\nAgents: 1\/1 active; 1 untasked; CPU 3\.0%; MEM 0\.5%$/m);
  assert.match(out, /^Next: resolve 1 untasked session: 1 interactive session$/m);
  assert.match(out, /^Untasked: 1 sessions \(1 interactive session\)\.$/m);
  assert.match(out, /^- 200 \S+: interactive session -> inspect pid 200 interactive claude session/m);
});

test('worktrees outside the root only show up with --global', () => {
  const root = makeRoot();
  const inside = path.join(root, 'wt-inside');
  const outside = path.join(sandbox, 'elsewhere', 'other-repo');
  const worktrees = [
    `worktree ${root}`, 'HEAD aaa', 'branch refs/heads/main', '',
    `worktree ${inside}`, 'HEAD bbb', 'branch refs/heads/agent/one', '',
    `worktree ${outside}`, 'HEAD ccc', 'detached', '',
  ].join('\n');
  const options = { root, execFileSync: fakeExec({ ps: '', worktrees }) };

  const local = JSON.parse(run(['--json'], options).out);
  assert.deepStrictEqual(local.worktrees.map(w => w.path), [root, inside]);
  assert.deepStrictEqual(local.worktrees.map(w => w.dirty), [2, 2]);
  assert.strictEqual(local.next_action, 'repair AgentXP integrity');

  const global = JSON.parse(run(['--json', '-g'], options).out);
  assert.strictEqual(global.scope, 'global');
  assert.deepStrictEqual(global.worktrees.map(w => w.path), [root, inside, outside]);
  assert.strictEqual(global.worktrees[2].branch, 'detached');

  const text = run([], options).out;
  assert.match(text, /^Worktrees: 2 registered, 2 dirty$/m);
  assert.match(text, /Dirty worktrees:\n- 2 files: /);
});

test('corrupt state files fall back to empty data instead of throwing', () => {
  const root = makeRoot({
    '.atris/state/tasks.projection.json': '{ this is not json',
    '.atris/state/career_xp.projection.json': '[[[',
    '.atris/state/scorecards.jsonl': 'nope\n\n',
  });
  const { code, out } = run(['--json'], { root, execFileSync: fakeExec({ ps: '' }) });
  assert.strictEqual(code, 0);
  const data = JSON.parse(out);
  assert.deepStrictEqual(data.tasks, []);
  assert.deepStrictEqual(data.agents, []);
  assert.strictEqual(data.os.xp.total, 0);
  assert.strictEqual(data.os.xp.integrity, 'unknown');
  assert.strictEqual(data.os.brain.scorecards, 0);
  assert.strictEqual(data.next_action, 'repair AgentXP integrity');
});
