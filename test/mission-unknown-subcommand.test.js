const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// [2026-07-07] lesson mission-say-mistype-creates-junk-mission: a mistyped verb
// like `atris mission say <id> <text>` used to fall through to runMission and
// silently create a garbage mission from the raw args. A bare single word that
// is not a known verb must error, while the quoted-objective and mission-id
// shortcuts keep working (routing only — not exercised here to avoid state writes).

const { missionCommand } = require(path.join('..', 'commands', 'mission.js'));

test('unknown single-word mission verb errors instead of creating a mission', () => {
  const errors = [];
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  console.error = (msg) => errors.push(String(msg));
  try {
    const result = missionCommand(['say', 'mission-2026-01-01-fake', 'some steering text']);
    assert.strictEqual(result, undefined, 'must not route to runMission');
    assert.strictEqual(process.exitCode, 1, 'must set a failing exit code');
    assert.ok(
      errors.some((line) => line.includes('Unknown mission subcommand "say"')),
      'must name the bad verb'
    );
    assert.ok(
      errors.some((line) => line.includes('atris wish say')),
      'must point at the real steering front door'
    );
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
});
