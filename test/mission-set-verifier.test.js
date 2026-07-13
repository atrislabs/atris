const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

test('mission set-verifier persists the verifier on a mission fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-set-verifier-'));
  const mission = {
    schema: 'atris.mission.v1',
    id: 'mission-2026-07-13-set-verifier',
    objective: 'prove verifier updates',
    owner: 'mission-lead',
    status: 'complete',
    verifier: '',
    created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
  };
  const verifier = 'node --test test/mission-set-verifier.test.js';

  try {
    const stateDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify(mission)}\n`, 'utf8');

    const result = spawnSync(process.execPath, [
      cliPath, 'mission', 'set-verifier', mission.id, verifier, '--json',
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: 'mission_set_verifier',
      mission_id: mission.id,
      verifier,
    });

    const saved = fs.readFileSync(path.join(stateDir, 'missions.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((row) => row.id === mission.id)
      .at(-1);
    assert.equal(saved.verifier, verifier);
    assert.equal(saved.status, 'complete');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
