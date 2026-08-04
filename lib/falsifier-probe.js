'use strict';

// A check that cannot fail is not a check. `task ready --verify` runs a command
// and accepts the work on exit 0, which catches a command that fails but never
// catches one that could not have failed. The 2026-07-26 reward-ledger audit
// found 131 of 802 accepted proofs carrying nothing falsifiable.
//
// The probe: run the same command again in an empty directory, with none of
// the work present. A check anchored to this codebase fails there. One that
// passes anywhere - `true`, `echo done`, a check of something outside the
// repo - passes there too, and proves nothing about the work.
//
// Scope, stated plainly: this asks whether a check depends on the codebase at
// all. It does not ask whether the check exercises the change. `git diff
// --check` fails in an empty directory and still says nothing about whether
// the code works, so it clears this probe. The probe raises the floor; it is
// not a ceiling.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROBE_TIMEOUT_MS = 60_000;

// An absolute path reaches back into a real checkout no matter where the
// command runs, so the empty directory proves nothing about it. Say so rather
// than reporting a false verdict.
function absolutePathIn(command) {
  const match = String(command || '').match(/(?:^|[\s"'`=(])(\/[^\s"'`)]+)/);
  return match ? match[1] : '';
}

function probeVerifierCanFail({ command, runner, tmpRoot } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { probed: false, canFail: null, reason: 'no command to probe' };

  const absolute = absolutePathIn(cmd);
  if (absolute) {
    return {
      probed: false,
      canFail: null,
      reason: `not probed: the command reaches an absolute path (${absolute}), so running it away from this checkout proves nothing`,
    };
  }

  const dir = fs.mkdtempSync(path.join(tmpRoot || os.tmpdir(), 'atris-falsifier-probe-'));
  try {
    const run = runner || spawnSync;
    const result = run('bash', ['-lc', cmd], {
      cwd: dir,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.error) {
      const timedOut = /ETIMEDOUT/i.test(String(result.error.code || result.error.message || ''));
      return {
        probed: false,
        canFail: null,
        reason: timedOut
          ? `not probed: the command ran past ${PROBE_TIMEOUT_MS / 1000}s with none of the work present`
          : `not probed: the command could not start away from this checkout (${result.error.message})`,
      };
    }
    if (result.status === 0) {
      return {
        probed: true,
        canFail: false,
        exit: 0,
        reason: 'this check passes in an empty directory, with none of the work present, so passing here says nothing about the work',
      };
    }
    return {
      probed: true,
      canFail: true,
      exit: result.status,
      reason: 'this check fails when the work is absent, so passing it means something',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { probeVerifierCanFail, absolutePathIn, PROBE_TIMEOUT_MS };
