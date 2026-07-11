'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadMissionMap, renderMissionStatus } = require('../commands/mission');

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-status-render-test-'));
}

function seedMissions(dir, missions) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const body = missions.map((m) => JSON.stringify({ schema: 'atris.mission.v1', ...m })).join('\n') + '\n';
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), body, 'utf8');
}

// --- loadMissionMap: JSONL → id-keyed map, last line wins ---

test('loadMissionMap returns an empty map when the JSONL is absent', () => {
  const dir = makeTempRepo();
  try {
    assert.equal(loadMissionMap(dir).size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMissionMap dedups by id with the last appended record winning', () => {
  const dir = makeTempRepo();
  try {
    seedMissions(dir, [
      { id: 'm1', objective: 'first write', owner: 'a', status: 'planning' },
      { id: 'm1', objective: 'second write', owner: 'a', status: 'running' },
      { id: 'm2', objective: 'other', owner: 'b', status: 'running' },
    ]);
    const map = loadMissionMap(dir);
    assert.equal(map.size, 2);
    assert.equal(map.get('m1').status, 'running', 'append-order latest wins, not first-seen');
    assert.equal(map.get('m1').objective, 'second write');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMissionMap skips records with no id', () => {
  const dir = makeTempRepo();
  try {
    seedMissions(dir, [
      { objective: 'no id here', owner: 'a', status: 'running' },
      { id: 'm9', objective: 'has id', owner: 'a', status: 'running' },
    ]);
    const map = loadMissionMap(dir);
    assert.equal(map.size, 1);
    assert.ok(map.has('m9'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- renderMissionStatus: writes atris/status/now.md ---

test('renderMissionStatus writes a "no missions" page when none exist', () => {
  const dir = makeTempRepo();
  try {
    const out = renderMissionStatus(dir);
    const text = fs.readFileSync(out, 'utf8');
    assert.match(text, /## Missions/);
    assert.match(text, /No missions yet\./);
    assert.match(text, /Active missions: 0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderMissionStatus renders mission fields and counts only non-terminal as active', () => {
  const dir = makeTempRepo();
  try {
    seedMissions(dir, [
      { id: 'm-run', objective: 'live work', owner: 'auto-improver', status: 'running', next_action: 'tick it', updated_at: '2026-06-13T02:00:00Z' },
      { id: 'm-done', objective: 'finished work', owner: 'auto-improver', status: 'complete', updated_at: '2026-06-13T01:00:00Z' },
    ]);
    const text = fs.readFileSync(renderMissionStatus(dir), 'utf8');
    // human surface: plain-word labels, never raw mission ids, no label stutter
    assert.match(text, /- \*\*live work\*\*\n/);
    assert.doesNotMatch(text, /^- .*m-run/m, 'headline shows the label, never the raw id');
    assert.match(text, /owner: auto-improver/);
    assert.match(text, /state: running/);
    assert.match(text, /next: tick it/);
    assert.match(text, /- \*\*finished work\*\*\n/, 'terminal missions still render in the list');
    assert.match(text, /Active missions: 1/, 'complete is terminal, so only the running mission is active');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderMissionStatus emits xp/proof/gate lines only when those fields are present', () => {
  const dir = makeTempRepo();
  try {
    seedMissions(dir, [
      {
        id: 'm-full', objective: 'rich mission', owner: 'a', status: 'running',
        xp_task: { ref: 'CLI-999', task_id: 'task-999' }, receipt_path: 'atris/runs/proof.json',
        completion_gate: { source: 'human-accept', forced: false },
        updated_at: '2026-06-13T03:00:00Z',
      },
      { id: 'm-bare', objective: 'sparse mission', owner: 'a', status: 'running', updated_at: '2026-06-13T02:00:00Z' },
    ]);
    const text = fs.readFileSync(renderMissionStatus(dir), 'utf8');
    assert.match(text, /task: CLI-999/);
    assert.match(text, /task next: atris task current-step --goal-id m-full --as a --proof "<proof>" --json/);
    assert.match(text, /task setup: atris mission attach-task m-bare --json/);
    assert.match(text, /AgentXP task: CLI-999/);
    assert.match(text, /proof: saved; inspect: atris mission timeline m-full --limit 5/);
    assert.doesNotMatch(text, /atris\/runs\/proof\.json/);
    assert.match(text, /gate: human-accept/);
    // the bare mission contributes no optional lines
    assert.equal((text.match(/^  - task:/gm) || []).length, 1);
    assert.equal((text.match(/^  - task next:/gm) || []).length, 1);
    assert.equal((text.match(/^  - task setup:/gm) || []).length, 1);
    assert.equal((text.match(/AgentXP task:/g) || []).length, 1);
    assert.equal((text.match(/proof:/g) || []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderMissionStatus caps the rendered list at 12 missions', () => {
  const dir = makeTempRepo();
  try {
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `m${String(i).padStart(2, '0')}`,
      objective: `mission ${i}`,
      owner: 'a',
      status: 'running',
      updated_at: `2026-06-13T${String(i).padStart(2, '0')}:00:00Z`,
    }));
    seedMissions(dir, many);
    const text = fs.readFileSync(renderMissionStatus(dir), 'utf8');
    const rendered = (text.match(/^- \*\*/gm) || []).length;
    assert.equal(rendered, 12, 'list is capped at 12 even with 14 missions');
    assert.match(text, /Active missions: 14/, 'the active count still reflects all missions');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
