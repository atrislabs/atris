#!/usr/bin/env node
// member-operate: the one executed slice of a member alive tick.
//
// Contract (lib/member-alive.js runMemberOperateScript):
//   node scripts/member-operate.mjs <member> --json --max-wall <60..1800>
//     --execute --confirm-autonomy-policy [--agent claude] [--model X] [--shared-checkout]
// stdout: final JSON only (last line wins). stderr: live progress, prefixed
// with ATRIS_MEMBER_OPERATE_PROGRESS\t so the alive loop can stream phases.
//
// This script is a dispatcher, not an engine. It delegates to
// `atris member run <member>`, which resumes the member's active mission or
// chooses one bounded useful task, and the mission itself carries its runner
// (codex_goal, claude, atris2, ...). Swapping engines is mission/member
// config, never an edit here.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PROGRESS_PREFIX = 'ATRIS_MEMBER_OPERATE_PROGRESS\t';

function progress(payload) {
  process.stderr.write(`${PROGRESS_PREFIX}${JSON.stringify(payload)}\n`);
}

function readFlag(args, name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function finish(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok === false ? 1 : 0);
}

function collectJsonSignals(text) {
  // member run / mission run print JSON payloads along the way; harvest the
  // fields the alive loop cares about without depending on exact shapes.
  const signals = { receipt_path: null, needs_user: false, summary: null, failed: false, reason: null, detail: null, mission_started: false, execution_result: false };
  let buffer = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!buffer && !line.trimStart().startsWith('{')) continue;
    buffer += line + '\n';
    for (const character of line) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}') depth--;
    }
    if (depth > 0) continue;
    try {
      const parsed = JSON.parse(buffer);
      const failedTick = parsed.action === 'mission_run' && Array.isArray(parsed.ticks)
        ? parsed.ticks.find((tick) => ['errored', 'failed'].includes(tick.status)
          || tick.claude?.ok === false || tick.atris2?.ok === false)
        : null;
      const missionErrored = parsed.action === 'mission_run'
        && ['errored', 'failed'].includes(parsed.mission?.last_tick_status);
      if (parsed.ok === false || failedTick || missionErrored) {
        signals.failed = true;
        signals.reason ||= parsed.reason || parsed.error || failedTick?.reason || 'operate_failed';
        signals.detail ||= parsed.detail || failedTick?.claude?.summary || failedTick?.atris2?.error || null;
      }
      if (parsed.action === 'mission_started') signals.mission_started = true;
      else if (parsed.action === 'mission_run') signals.execution_result ||= Number(parsed.ran_ticks) > 0;
      else if (parsed.executed === true || parsed.result || parsed.receipt_path) signals.execution_result = true;
      if (parsed.receipt_path) signals.receipt_path = parsed.receipt_path;
      if (parsed.mission?.receipt_path) signals.receipt_path = parsed.mission.receipt_path;
      if (parsed.needs_user === true) signals.needs_user = true;
      const landing = parsed.result?.landing || parsed.landing || null;
      if (landing?.changed) signals.summary = landing.changed;
      else if (parsed.summary) signals.summary = parsed.summary;
    } catch {
      // A log line that resembles JSON is not a result.
    }
    buffer = '';
    depth = 0;
    quoted = false;
    escaped = false;
  }
  return signals;
}

const argv = process.argv.slice(2);
const member = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
const args = argv.slice(1);

if (!member) {
  finish({ ok: false, reason: 'member_required', executed: false });
}

const execute = args.includes('--execute');
const confirmed = args.includes('--confirm-autonomy-policy');
if (!execute || !confirmed) {
  finish({ ok: true, reason: 'operate_dry_run', member, executed: false });
}

const maxWall = Math.max(60, Math.min(1800, Number(readFlag(args, '--max-wall', '900')) || 900));
const agent = String(readFlag(args, '--agent', '')).trim().toLowerCase();
const model = String(readFlag(args, '--model', '')).trim();

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Resolution order: explicit env, repo checkout beside this script, then the
// installed CLI on PATH (cloud workspaces carry this script without the repo).
function resolveAtrisBin() {
  const candidates = [
    process.env.ATRIS_BIN,
    path.join(scriptDir, '..', 'bin', 'atris.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const pathDirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'atris');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
const atrisBin = resolveAtrisBin();
if (!atrisBin) {
  finish({ ok: false, reason: 'atris_bin_not_found', member, executed: false });
}

const runArgs = [atrisBin, 'member', 'run', member, '--json', '--max-wall', String(maxWall)];
if (agent === 'claude') runArgs.push('--runner', 'claude');
if (model) runArgs.push('--model', model);
if (args.includes('--shared-checkout')) runArgs.push('--shared-checkout');

progress({ kind: 'phase', text: `Dispatching one bounded ${member} slice (wall cap ${maxWall}s).` });

const child = spawn(process.execPath, runArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let errors = '';
const forward = (chunk, isError = false) => {
  const text = chunk.toString();
  if (isError) errors += text;
  else output += text;
  // Keep stdout clean for the final JSON; the human-visible stream is stderr.
  process.stderr.write(text);
};
child.stdout.on('data', forward);
child.stderr.on('data', (chunk) => forward(chunk, true));

const wallTimer = setTimeout(() => {
  progress({ kind: 'phase', text: `Wall cap ${maxWall}s reached; stopping the slice.` });
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 10000).unref();
}, maxWall * 1000);

child.on('close', (code) => {
  clearTimeout(wallTimer);
  const signals = collectJsonSignals(output + '\n' + errors);
  const ok = code === 0 && !signals.failed;
  const planned = ok && !signals.execution_result;
  finish({
    ok,
    reason: planned ? signals.mission_started ? 'mission_started' : 'no_execution_evidence' : ok ? 'operate_complete' : signals.reason || 'operate_failed',
    ...(planned ? { status: 'planned' } : {}),
    ...(signals.detail ? { detail: signals.detail } : {}),
    member,
    executed: !planned,
    exit_code: code,
    max_wall_seconds: maxWall,
    needs_user: signals.needs_user,
    receipt_path: planned ? null : signals.receipt_path,
    summary: signals.summary,
  });
});

child.on('error', (error) => {
  clearTimeout(wallTimer);
  finish({ ok: false, reason: `operate_spawn_failed: ${error.message}`, member, executed: true });
});
