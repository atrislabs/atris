'use strict';

// Finished member work lands itself when the owner turned self-landing on.
//
// `atris member run ... --ignite` ends with the work committed on the
// mission's own branch and the mission complete. Before this module a human
// merged that branch by hand. Now, with the autoland switch on and the mission
// outside every protected lane, the branch is rebased on the latest origin
// default branch and handed to the same `worktree ship --verify --merge` path
// fleet flights use, so the mission's check reruns on the rebased tree before
// anything merges. Anything short of a clean merge leaves the branch where it
// is and says why in one plain line. Switch off means nothing here runs.

const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function protectedReason(mission) {
  const {
    deniedTagOf,
    declaredProtectedLane,
    sniffedProtectedLane,
  } = require('./auto-accept-certified');
  const view = {
    title: mission.title || '',
    objective: mission.objective || '',
    tag: [mission.tag, mission.lane].filter(Boolean).join(' '),
    metadata: {},
  };
  const denied = deniedTagOf(view);
  if (denied) return `it sits in the protected ${denied} lane, so a human lands it`;
  const declared = declaredProtectedLane(view);
  if (declared) return `its text says "${declared.phrase}", so a human lands it`;
  const sniffed = sniffedProtectedLane(view);
  if (sniffed) return `it mentions ${sniffed.term}, which belongs to the protected ${sniffed.lane} lane, so a human lands it`;
  return null;
}

function shipMessage(mission) {
  const words = String(mission.objective || mission.title || 'member work').replace(/\s+/g, ' ').trim();
  const short = words.length > 80 ? `${words.slice(0, 80).replace(/\s+\S*$/, '')}...` : words;
  return `${mission.owner || 'member'}: ${short}`;
}

// The worktree ship command, run in the member's own checkout. Returns the
// spawn result so the caller can read what the ship path printed.
function shipThroughWorktree({ worktreePath, message, check, targetRef, env = process.env }) {
  return spawnSync(process.execPath, [
    CLI, 'worktree', 'ship',
    '--message', message,
    '--verify', check,
    '--target', targetRef,
    '--merge',
  ], { cwd: worktreePath, encoding: 'utf8', env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1' }, maxBuffer: 64 * 1024 * 1024 });
}

function rebaseReason(rebased, base) {
  if (rebased.stage === 'rebase_conflict') {
    const files = (rebased.conflicts || []).slice(0, 3).join(', ');
    return `it conflicts with the latest ${base}${files ? ` in ${files}` : ''}`;
  }
  if (rebased.stage === 'dirty_worktree') return 'its checkout has uncommitted changes';
  if (rebased.stage === 'fetch') return `could not fetch the latest ${base}`;
  return `the rebase on ${base} failed`;
}

function shipReason(shipped) {
  const out = String(shipped.stdout || '');
  const err = String(shipped.stderr || '').replace(/^\s*✗ Error:\s*/m, '').trim();
  if (/^verify: /m.test(out) && !/^merge_check: /m.test(out)) {
    return 'its check failed after the rebase';
  }
  const blocked = err.split(/\r?\n/).find((line) => /^blocked: /.test(line.trim()));
  if (blocked) return blocked.trim().replace(/^blocked: /, '');
  const first = err.split(/\r?\n/).find(Boolean);
  return first ? `the merge failed: ${first.trim().slice(0, 160)}` : 'the merge did not finish';
}

// Returns { attempted, landed, reason, line }. `attempted: false` means the
// switch is off and the run behaves exactly as before.
function landFinishedMemberRun({
  root = process.cwd(),
  mission,
  env = process.env,
  authorize = (dir) => require('./autoland').liveAcceptAuthorization(dir),
  mainline = (dir) => require('../commands/worktree').defaultMainlineBase(dir),
  rebase = (opts) => require('./fleet').landArrival(opts),
  ship = shipThroughWorktree,
} = {}) {
  if (!authorize(root).ok) return { attempted: false, landed: false, reason: 'policy_off', line: '' };
  const held = (reason, why) => ({ attempted: true, landed: false, reason, line: `left on its branch: ${why}` });
  if (!mission || mission.status !== 'complete') return held('check_not_passed', 'its check has not passed');
  const worktreePath = mission.worktree && mission.worktree.path;
  if (!worktreePath) {
    return { attempted: true, landed: false, reason: 'no_branch', line: 'not landed: it ran in the main checkout, not on its own branch' };
  }
  const check = String(mission.verifier || '').trim();
  if (!check) return held('no_check', 'it has no check to rerun after the rebase');
  const lane = protectedReason(mission);
  if (lane) return held('protected_lane', lane);

  let targetRef;
  try {
    targetRef = mainline(worktreePath);
  } catch (error) {
    return held('no_base', String(error && error.message || error));
  }
  if (!targetRef || targetRef === 'HEAD') return held('no_base', 'there is no origin default branch to land on');
  const base = targetRef.replace(/^origin\//, '');

  const rebased = rebase({ worktreePath, targetRef });
  if (!rebased.ok) return held(rebased.stage || 'rebase_failed', rebaseReason(rebased, base));

  const shipped = ship({ worktreePath, message: shipMessage(mission), check, targetRef, env });
  if (shipped.status !== 0 || !/^merge: merged/m.test(String(shipped.stdout || ''))) {
    return held('ship_failed', shipReason(shipped));
  }
  return { attempted: true, landed: true, reason: 'landed', line: `landed: merged into ${base} after its check passed again` };
}

module.exports = {
  landFinishedMemberRun,
  protectedReason,
  shipThroughWorktree,
};
