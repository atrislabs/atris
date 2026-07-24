'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { reasonClass, HUMAN_BLOCKING_REASONS } = require('../lib/self-drive');
const { missionLockRecords } = require('../lib/loop-doctor');
const {
  loadMissionMap,
  acquireMissionLock,
  releaseMissionLock,
} = require('./mission');

const RECOVERY_CATALOG = [
  {
    id: 'max-ticks-reached',
    matches: (reason) => reason === 'max-ticks-reached',
    happened: 'the run used its tick allowance before the mission finished',
    apply: 'resume',
  },
  {
    id: 'verifier-failed',
    matches: (reason) => reason === 'verifier-failed' || reason === 'verifier_failed',
    happened: 'the mission verifier failed',
    apply: 'verifier',
  },
  {
    id: 'repeated-error:claude-error',
    matches: (reason) => reason === 'repeated-error:claude-error' || reason.startsWith('repeated-error:'),
    happened: 'the worker returned the same error twice',
    apply: null,
  },
  {
    id: 'aborted-during-claude',
    matches: (reason) => reason === 'aborted-during-claude',
    happened: 'the worker was interrupted during its tick',
    apply: 'resume',
  },
  {
    id: 'aborted',
    matches: (reason) => reason === 'aborted',
    happened: 'the mission run was interrupted',
    apply: 'resume',
  },
  {
    id: 'stuck-repeating',
    matches: (reason) => ['stuck-repeating', 'repeated-pause-reason', 'repeated_pause_reason'].includes(reason),
    happened: 'the worker kept returning the same pause or summary',
    apply: 'resume',
  },
  {
    id: 'lock-busy',
    matches: (reason) => ['lock-busy', 'stale-mission-lock', 'stale_mission_lock'].includes(reason),
    happened: 'a mission tick lock prevented another tick from starting',
    apply: null,
  },
  {
    id: 'auth-required',
    matches: (reason) => reason === 'auth-required',
    happened: 'the runner needs an operator login',
    apply: null,
  },
  {
    id: 'model-unavailable',
    matches: (reason) => reason === 'model-unavailable',
    happened: 'the configured model is unavailable',
    apply: null,
  },
  {
    id: 'rate-limit-exceeded-wall',
    matches: (reason) => reason === 'rate-limit-exceeded-wall',
    happened: 'the rate-limit reset falls outside this run window',
    apply: null,
  },
];

function classifyRecovery(value) {
  const reason = reasonClass(value);
  const entry = RECOVERY_CATALOG.find((candidate) => candidate.matches(reason));
  if (entry) {
    return {
      catalog_entry: entry.id,
      reason,
      happened: entry.happened,
      apply: entry.apply,
      human_blocking: HUMAN_BLOCKING_REASONS.has(reason),
    };
  }
  return {
    catalog_entry: 'unknown',
    reason,
    happened: `the mission stopped for "${reason}"`,
    apply: null,
    human_blocking: HUMAN_BLOCKING_REASONS.has(reason),
  };
}

function missionStopReason(mission) {
  if (mission.stop_reason) return mission.stop_reason;
  if (mission.pause_reason) return mission.pause_reason;
  if (mission.status === 'blocked' && mission.verifier_result?.passed === false) return 'verifier-failed';
  return mission.last_tick_reason || mission.status || 'blocked';
}

function manualRecoveryCommand(row) {
  const id = row.mission_id;
  switch (row.catalog_entry) {
    case 'auth-required':
      return 'atris login';
    case 'model-unavailable':
      return `atris mission set-runner ${id} auto`;
    case 'rate-limit-exceeded-wall':
      return `atris mission run ${id}`;
    case 'repeated-error:claude-error':
      return `atris mission run ${id}`;
    case 'lock-busy':
      return `atris mission status ${id} --json`;
    default:
      return `atris mission status ${id} --json`;
  }
}

function recoveryCommand(row) {
  if (row.apply === 'stale-lock') return `atris recover ${row.mission_id} --apply`;
  if (row.human_blocking || !row.apply) return manualRecoveryCommand(row);
  return `atris recover ${row.mission_id} --apply`;
}

function missionRows(root) {
  return [...loadMissionMap(root).values()]
    .filter((mission) => ['blocked', 'paused'].includes(String(mission.status || '').toLowerCase()))
    .map((mission) => {
      const classified = classifyRecovery(missionStopReason(mission));
      const verifier = String(mission.verifier || mission.effective_verifier || '').trim();
      const missingVerifier = classified.apply === 'verifier' && !verifier;
      const hasHumanAsk = Array.isArray(mission.human_asks) && mission.human_asks.length > 0;
      const operatorRequired = missingVerifier || hasHumanAsk;
      return {
        mission_id: mission.id,
        mission: mission.objective || mission.id,
        status: mission.status,
        receipt_path: mission.receipt_path || null,
        next_action: mission.next_action || null,
        verifier: verifier || null,
        ...classified,
        ...(operatorRequired ? {
          apply: null,
          operator_required: true,
          happened: hasHumanAsk
            ? `${classified.happened}, and the mission has a human ask`
            : `${classified.happened}, but no verifier command is configured`,
        } : {}),
      };
    });
}

function lockRows(root) {
  return missionLockRecords(root).map((lock) => {
    const match = String(lock.lock || '').match(/^mission-(.+)[.]lock$/);
    const missionId = match ? match[1] : String(lock.lock || '').replace(/[.]lock$/, '');
    const classified = classifyRecovery('stale_mission_lock');
    const stale = lock.stale === true;
    return {
      mission_id: missionId,
      mission: missionId,
      status: 'lock busy',
      receipt_path: null,
      next_action: null,
      ...classified,
      happened: stale
        ? classified.happened
        : `the mission tick lock is held by live pid ${lock.pid}`,
      apply: stale ? 'stale-lock' : null,
      operator_required: !stale,
      stale_lock: {
        file: lock.lock,
        pid: lock.pid,
        reason: lock.reason,
      },
    };
  });
}

function selectRows(root, ref = '') {
  const selected = [...lockRows(root), ...missionRows(root)];
  if (!ref) return selected;
  const needle = String(ref).trim();
  return selected.filter((row) => row.mission_id === needle || row.mission_id.includes(needle));
}

function runMissionTick(root, row, verify) {
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const args = [
    cli,
    'mission',
    'tick',
    row.mission_id,
    ...(verify ? ['--verify'] : []),
    '--summary',
    verify ? 'recovery reran the mission verifier' : 'recovery resumed the paused mission',
    '--json',
  ];
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

function applyStaleLock(root, row) {
  const lock = acquireMissionLock(row.mission_id, root);
  if (!lock.ok) {
    return {
      outcome: 'needs operator',
      detail: `lock is still held by pid ${lock.holder?.pid || '?'}`,
    };
  }
  releaseMissionLock(lock);
  const lockPath = path.join(root, '.atris', 'state', row.stale_lock.file);
  return fs.existsSync(lockPath)
    ? { outcome: 'failed', detail: 'stale lock still exists' }
    : { outcome: 'recovered', detail: 'cleared the stale mission tick lock' };
}

function applyMissionRow(root, row) {
  if (row.human_blocking || row.operator_required) {
    return { outcome: 'needs operator', detail: row.happened };
  }
  if (row.apply === 'stale-lock') return applyStaleLock(root, row);
  if (!row.apply) {
    return { outcome: 'not applied', detail: 'the cause must be inspected before another run' };
  }
  if (row.apply === 'resume' && row.status !== 'paused') {
    return { outcome: 'not applied', detail: 'only paused missions are resumed automatically' };
  }
  const run = runMissionTick(root, row, row.apply === 'verifier');
  if (run.error || run.status !== 0) {
    return {
      outcome: 'failed',
      detail: String(run.error?.message || run.stderr || run.stdout || 'mission tick failed').trim(),
    };
  }
  const mission = loadMissionMap(root).get(row.mission_id) || null;
  if (row.apply === 'verifier' && mission?.verifier_result?.passed !== true) {
    return {
      outcome: 'still blocked',
      detail: 'the verifier still fails',
      end_state: mission,
    };
  }
  return {
    outcome: 'recovered',
    detail: row.apply === 'verifier' ? 'the verifier passed' : 'the mission resumed',
    end_state: mission,
  };
}

function writeRecoveryReceipt(root, results) {
  const runs = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const at = new Date().toISOString();
  const name = `recover-${at.replace(/[:.]/g, '-')}-${process.pid}.json`;
  const relative = path.join('atris', 'runs', name);
  fs.writeFileSync(path.join(root, relative), `${JSON.stringify({
    schema: 'atris.recovery_receipt.v1',
    at,
    applied: true,
    results: results.map((row) => ({
      mission_id: row.mission_id,
      catalog_entry: row.catalog_entry,
      previous_status: row.status,
      outcome: row.outcome,
      detail: row.detail,
      end_status: row.end_state?.status || row.status,
      mission_receipt: row.end_state?.receipt_path || row.receipt_path || null,
      next_action: row.end_state?.next_action || row.next_action || recoveryCommand(row),
    })),
  }, null, 2)}\n`);
  return relative;
}

function textLines(rows, receiptPath, applying) {
  if (!rows.length) return ['recovery report', 'no blocked or paused missions found'];
  const lines = ['recovery report'];
  for (const row of rows) {
    const state = row.human_blocking || row.operator_required
      ? 'needs operator'
      : (applying ? `${row.outcome}: ${row.detail}` : (row.apply ? 'safe to apply' : 'report only'));
    lines.push(
      `${row.mission_id}: ${row.happened}`,
      `  ${state}; next: ${recoveryCommand(row)}`,
      `  receipt: ${row.end_state?.receipt_path || row.receipt_path || 'none today'}`,
    );
  }
  if (receiptPath) lines.push(`recovery receipt: ${receiptPath}`);
  return lines;
}

function parseArgs(args) {
  const apply = args.includes('--apply');
  const json = args.includes('--json');
  const help = args.includes('--help') || args.includes('-h') || args[0] === 'help';
  const ref = args.find((arg) => !String(arg).startsWith('-') && arg !== 'help') || '';
  return { apply, json, help, ref };
}

function recoverCommand(args = [], options = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log('Usage: atris recover [mission-id] [--apply] [--json]');
    console.log('Reports blocked and paused missions. --apply clears dead locks, resumes safe pauses, and reruns failed verifiers.');
    return 0;
  }
  const root = path.resolve(options.root || process.cwd());
  const rows = selectRows(root, parsed.ref);
  const results = parsed.apply
    ? rows.map((row) => ({ ...row, ...applyMissionRow(root, row) }))
    : rows;
  const receiptPath = parsed.apply ? writeRecoveryReceipt(root, results) : null;
  const payload = {
    ok: true,
    action: parsed.apply ? 'recovery_applied' : 'recovery_report',
    report_only: !parsed.apply,
    results: results.map((row) => ({
      ...row,
      recovery_command: recoveryCommand(row),
      disposition: row.human_blocking || row.operator_required ? 'needs operator' : (row.apply ? 'safe' : 'report only'),
    })),
    receipt_path: receiptPath,
  };
  if (parsed.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(textLines(results, receiptPath, parsed.apply).join('\n'));
  return 0;
}

module.exports = {
  classifyRecovery,
  recoverCommand,
};
