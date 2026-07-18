'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

test('orb --once prints deterministic suggestions without spawning an engine', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-orb-'));
  try {
    const stateDir = path.join(fixture, '.atris', 'state');
    const fakeBin = path.join(fixture, 'bin');
    const spawnMarker = path.join(fixture, 'engine-spawned');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });

    const nowText = '# Now\n\n2026-07-18 shipped the fixture.\n';
    fs.writeFileSync(path.join(fixture, 'now.md'), nowText);
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [
        { display_id: 'CLI-1154', title: 'Build the Orb CLI loop', status: 'open', updated_at: '2026-07-18T09:00:00.000Z' },
        { display_id: 'CLI-1153', title: 'Review the desktop Orb proof', status: 'review', updated_at: '2026-07-18T10:00:00.000Z' },
      ],
    }));

    for (const engine of ['claude', 'codex', 'ax']) {
      const executable = path.join(fakeBin, engine);
      fs.writeFileSync(executable, '#!/bin/sh\nprintf spawned >> "$ORB_SPAWN_MARKER"\n');
      fs.chmodSync(executable, 0o755);
    }

    const result = spawnSync(process.execPath, [cliPath, 'orb', '--once'], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...scrubAgentEnv(),
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ORB_SPAWN_MARKER: spawnMarker,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      },
    });

    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^1\. /m);
    assert.match(result.stdout, /Review the desktop Orb proof/);
    assert.equal(fs.existsSync(spawnMarker), false, 'no engine executable was spawned');
    assert.equal(fs.existsSync(path.join(stateDir, 'orb-runs')), false, 'no background run was created');
    assert.equal(fs.readFileSync(path.join(fixture, 'now.md'), 'utf8'), nowText, 'once mode leaves now.md unchanged');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
