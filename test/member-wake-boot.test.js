'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { wakeBootLines } = require('../commands/member');

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function render(result) {
  return stripAnsi(wakeBootLines('maze', result).join('\n'));
}

const baseResult = {
  decision: 'ask',
  reason: 'mission_missing_or_placeholder',
  ask: 'Define atris/team/maze/MISSION.md with a concrete North Star before this member wakes itself.',
  next_command: 'edit atris/team/maze/MISSION.md',
  receipt_path: path.join(process.cwd(), 'atris', 'runs', 'member-wake-maze-x.json'),
  mission: { north_star: null },
  active_goal: null,
  current_experiment: null,
  evidence: { task_projection: { candidate_count: 0 } },
  created_task: null,
};

test('wake boot translates reason codes into plain English', () => {
  const output = render(baseResult);
  assert.ok(!output.includes('mission_missing_or_placeholder'), 'raw reason code must not leak to humans');
  assert.ok(output.includes('no North Star yet'));
  assert.ok(output.includes('needs one thing from you'));
});

test('wake boot surfaces the ask, next step, and receipt', () => {
  const output = render(baseResult);
  assert.ok(output.includes('One thing from you:'));
  assert.ok(output.includes(baseResult.ask));
  assert.ok(output.includes('edit atris/team/maze/MISSION.md'));
  assert.ok(output.includes('member-wake-maze-x.json'));
});

test('every decision code in member.js renders as grammatical English', () => {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'commands', 'member.js'), 'utf8');
  const codes = new Set([...source.matchAll(/decision\s*[=:]\s*'([a-z_]+)'/g)].map(m => m[1]));
  assert.ok(codes.size >= 10, `expected to find decision codes in source, got ${codes.size}`);
  for (const code of codes) {
    const output = render({ ...baseResult, decision: code, ask: null });
    assert.ok(!new RegExp(`looked around and ${code}\\.`).test(output), `raw code "${code}" leaked as sentence tail`);
  }
});

test('when the ball is with the human, the next step reads "Your move"', () => {
  const waiting = render({
    ...baseResult,
    decision: 'wait',
    reason: 'open_experiment_proposed',
    ask: null,
    next_command: 'atris member review maze exp-1 --accept --proof "..." --value 4',
  });
  assert.ok(waiting.includes('Your move'));
  assert.ok(waiting.includes('an experiment on the table'));

  const working = render({ ...baseResult, decision: 'tick', reason: 'safe_next_bounded_step', ask: null, needs_user: false });
  assert.ok(working.includes('Next step'));
  assert.ok(!working.includes('Your move'));
});

test('wake boot shows goal, experiment, and unknown reasons degrade gracefully', () => {
  const output = render({
    ...baseResult,
    decision: 'wait',
    reason: 'some_future_reason_code',
    ask: null,
    mission: { north_star: 'Close $10M on the social graph' },
    active_goal: { title: 'Ship the graph block' },
    current_experiment: { title: 'Rank rainmaker paths on total context' },
  });
  assert.ok(output.includes('decided to hold'));
  assert.ok(output.includes('some future reason code'), 'unknown codes become readable words');
  assert.ok(output.includes('Close $10M on the social graph'));
  assert.ok(output.includes('Ship the graph block'));
  assert.ok(output.includes('Rank rainmaker paths on total context'));
  assert.ok(!output.includes('One thing from you:'));
});
