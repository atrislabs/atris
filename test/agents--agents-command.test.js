'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agents-command-'));
  const saved = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  t.after(() => {
    delete process.env.HOME;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { agentsCommand } = require('../commands/agents');
  return {
    member(name) {
      fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    },
    missions(records) {
      const file = path.join(root, '.atris', 'state', 'missions.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, records.map(record => JSON.stringify({
        schema: 'atris.mission.v1', updated_at: '2024-01-01T00:00:00Z', ...record,
      })).join('\n') + '\n');
    },
    run(args = []) {
      const lines = [];
      const original = console.log;
      console.log = line => lines.push(line);
      try {
        const code = agentsCommand(args, { root });
        assert.strictEqual(code, 0);
        return lines;
      } finally {
        console.log = original;
      }
    },
  };
}

test('prints active members in priority order and folds or expands the resting tail', t => {
  const f = fixture(t);
  f.member('idle');
  f.missions([
    { id: 'working', n: 1, owner: 'builder', status: 'running', objective: 'ship release' },
    { id: 'blocked', n: 2, owner: 'checker', status: 'blocked', objective: 'fix login' },
    { id: 'ready', n: 3, owner: 'reviewer', status: 'ready', objective: 'review patch' },
    { id: 'done', n: 4, owner: 'writer', status: 'complete', objective: 'write notes' },
  ]);
  const head = [
    'checker - stuck - #2 fix login',
    'reviewer - waiting on you - #3 review patch',
    'builder - working - #1 ship release',
  ];
  assert.deepStrictEqual(f.run(), [...head,
    '2 members resting or idle. See them with atris agents --all']);
  assert.deepStrictEqual(f.run(['--all']), [...head,
    'writer - resting - #4 write notes', 'idle - idle']);
});

test('JSON uses the latest mission record and ignores hidden and template directories', t => {
  const f = fixture(t);
  f.member('builder');
  f.member('_template');
  f.member('.hidden');
  f.missions([
    { id: 'same', n: 1, owner: 'builder', status: 'blocked', objective: 'old failure' },
    { id: 'same', n: 1, owner: 'builder', status: 'ready', objective: 'review patch',
      updated_at: '2024-01-02T00:00:00Z' },
    { id: 'unowned', owner: '   ', status: 'blocked', objective: 'ignore record' },
  ]);
  for (const all of [false, true]) {
    const lines = f.run(all ? ['--json', '--all'] : ['--json']);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(JSON.parse(lines[0]), {
      schema: 'atris.agents.v1', all,
      agents: [{ owner: 'builder', state: 'waiting on you', label: '#1 review patch' }],
    });
  }
});

test('empty workspace prints guidance or an empty JSON roster, and supports help', t => {
  const f = fixture(t);
  assert.deepStrictEqual(f.run(), [
    'No agents found. Add someone to atris/team or start a mission.',
  ]);
  assert.deepStrictEqual(JSON.parse(f.run(['--json'])[0]), {
    schema: 'atris.agents.v1', all: false, agents: [],
  });
  for (const flag of ['--help', '-h']) {
    assert.deepStrictEqual(f.run([flag, '--json']), [
      'Usage: atris agents [--all] [--json]',
      'Shows every member: stuck, waiting on you, working, or resting.',
    ]);
  }
  f.member('alone');
  assert.deepStrictEqual(f.run(), [
    '1 member resting or idle. See them with atris agents --all',
  ]);
});
