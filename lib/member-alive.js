'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function stampIso() {
  return new Date().toISOString();
}

function parseJsonMaybe(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lastLine = trimmed.split(/\r?\n/).filter(Boolean).at(-1);
    if (!lastLine) return null;
    try {
      return JSON.parse(lastLine);
    } catch {
      return null;
    }
  }
}

function resolveAtrisBin(explicit) {
  if (explicit) return explicit;
  if (process.env.ATRIS_BIN) return process.env.ATRIS_BIN;
  const local = path.join(__dirname, '..', 'bin', 'atris.js');
  if (fs.existsSync(local)) return local;
  return 'atris';
}

function runCli(bin, args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const command = bin.endsWith('.js') ? process.execPath : bin;
  const argv = bin.endsWith('.js') ? [bin, ...args] : args;
  const result = spawnSync(command, argv, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    timeout: opts.timeoutMs || 120000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    json: parseJsonMaybe(result.stdout) || parseJsonMaybe(result.stderr),
  };
}

function resolveMemberOperateScript(cwd) {
  const candidates = [
    path.join(cwd, 'scripts', 'member-operate.mjs'),
    path.join(cwd, 'scripts', 'member-operate.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function runMemberOperateScript(scriptPath, member, opts) {
  const args = [
    scriptPath,
    member,
    '--json',
    '--max-wall',
    String(Math.max(60, Math.min(1800, Number(opts.maxWallSeconds) || 900))),
  ];
  if (opts.execute) {
    args.push('--execute');
    if (opts.confirmed) args.push('--confirm-autonomy-policy');
  }
  if (opts.agent === 'claude') args.push('--agent', 'claude');
  if (opts.noPrime) args.push('--no-prime');
  const result = spawnSync(process.execPath, args, {
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
    env: process.env,
    timeout: (Number(opts.maxWallSeconds) || 900) * 1000 + 15000,
  });
  const json = parseJsonMaybe(result.stdout) || parseJsonMaybe(result.stderr);
  return {
    ok: result.status === 0 && json?.ok !== false,
    status: result.status,
    payload: json,
    reason: json?.reason || json?.error || (result.status === 0 ? 'operate_complete' : 'operate_failed'),
    needs_user: Boolean(json?.needs_user),
    receipt_path: json?.receipt_path || null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runAliveTick(name, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const atrisBin = resolveAtrisBin(opts.atrisBin);
  const startedAt = stampIso();
  const tick = {
    schema: 'atris.member_alive_tick.v1',
    member: name,
    mode: opts.execute ? 'execute' : 'dry_run',
    started_at: startedAt,
  };

  if (!opts.noPrime) {
    tick.prime = runCli(atrisBin, ['member', 'goal-from-mission', name, '--json'], { cwd, timeoutMs: 120000 });
  }

  const wake = runCli(atrisBin, [
    'member', 'wake', name, '--json',
    ...(opts.force ? ['--force'] : []),
  ], { cwd, timeoutMs: 120000 });
  tick.wake = wake;
  const wakeJson = wake.json || {};
  tick.has_mission = wakeJson.checks?.has_mission === true;
  tick.has_goal = wakeJson.checks?.has_goal === true;
  tick.needs_user = Boolean(wakeJson.needs_user);
  tick.next_command = wakeJson.next_command || null;

  if (!opts.execute || !opts.confirmed) {
    tick.operate = { ok: true, skipped: true, reason: 'dry_run' };
    tick.auto_accept = { ok: true, skipped: true, reason: 'dry_run' };
    tick.status = tick.needs_user ? 'needs_user' : 'planned';
    tick.reason = 'alive_dry_run';
    tick.ok = true;
    tick.finished_at = stampIso();
    return tick;
  }

  if (tick.needs_user && wakeJson.decision === 'ask') {
    tick.operate = { ok: true, skipped: true, reason: 'blocked_on_human_ask' };
    tick.auto_accept = runCli(atrisBin, [
      'task', 'auto-accept-certified',
      '--dry-run',
      '--limit', String(Math.max(1, Number(opts.autoAcceptLimit) || 8)),
      '--json',
    ], { cwd, timeoutMs: 180000 });
    tick.status = 'needs_user';
    tick.reason = 'human_ask';
    tick.ok = tick.auto_accept.ok !== false;
    tick.finished_at = stampIso();
    return tick;
  }

  const operateScript = resolveMemberOperateScript(cwd);
  if (!operateScript) {
    tick.operate = { ok: false, reason: 'member_operate_script_missing' };
    tick.status = 'blocked';
    tick.reason = 'missing_member_operate_script';
    tick.ok = false;
    tick.finished_at = stampIso();
    return tick;
  }

  tick.operate = runMemberOperateScript(operateScript, name, {
    cwd,
    execute: true,
    confirmed: true,
    maxWallSeconds: opts.maxWallSeconds,
    agent: opts.agent || 'codex',
    noPrime: true,
  });
  tick.needs_user = tick.needs_user || tick.operate.needs_user === true;

  tick.auto_accept = runCli(atrisBin, [
    'task', 'auto-accept-certified',
    '--dry-run',
    '--limit', String(Math.max(1, Number(opts.autoAcceptLimit) || 8)),
    '--json',
  ], { cwd, timeoutMs: 180000 });

  const operateOk = tick.operate.ok !== false;
  const acceptOk = tick.auto_accept.ok !== false;
  tick.ok = operateOk && acceptOk;
  tick.status = tick.needs_user
    ? 'needs_user'
    : tick.ok
      ? 'completed'
      : 'failed';
  tick.reason = tick.ok
    ? 'alive_tick_complete'
    : tick.operate.reason || tick.auto_accept.json?.summary
      ? 'partial_failure'
      : 'alive_tick_failed';
  tick.receipt_path = tick.operate.receipt_path || wakeJson.receipt_path || null;
  tick.finished_at = stampIso();
  return tick;
}

module.exports = {
  runAliveTick,
  resolveMemberOperateScript,
  resolveAtrisBin,
};
