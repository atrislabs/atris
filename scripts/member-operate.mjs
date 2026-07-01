#!/usr/bin/env node
// member-operate: the one executed slice of a member alive tick.
//
// Contract (lib/member-alive.js runMemberOperateScript):
//   node scripts/member-operate.mjs <member> --json --max-wall <60..1800>
//     --execute --confirm-autonomy-policy [--agent claude] [--model X] [--no-prime]
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
  const signals = { receipt_path: null, needs_user: false, summary: null };
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.receipt_path) signals.receipt_path = parsed.receipt_path;
      if (parsed.mission?.receipt_path) signals.receipt_path = parsed.mission.receipt_path;
      if (parsed.needs_user === true) signals.needs_user = true;
      const landing = parsed.result?.landing || parsed.landing || null;
      if (landing?.changed) signals.summary = landing.changed;
      else if (parsed.summary) signals.summary = parsed.summary;
    } catch {
      // Partial or non-JSON line; keep streaming.
    }
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
const atrisBin = process.env.ATRIS_BIN || path.join(scriptDir, '..', 'bin', 'atris.js');
if (!fs.existsSync(atrisBin)) {
  finish({ ok: false, reason: 'atris_bin_not_found', member, executed: false });
}

const runArgs = [atrisBin, 'member', 'run', member, '--json', '--max-wall', String(maxWall)];
if (agent === 'claude') runArgs.push('--runner', 'claude');
if (model) runArgs.push('--model', model);

progress({ kind: 'phase', text: `Dispatching one bounded ${member} slice (wall cap ${maxWall}s).` });

const child = spawn(process.execPath, runArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const forward = (chunk) => {
  const text = chunk.toString();
  output += text;
  // Keep stdout clean for the final JSON; the human-visible stream is stderr.
  process.stderr.write(text);
};
child.stdout.on('data', forward);
child.stderr.on('data', forward);

const wallTimer = setTimeout(() => {
  progress({ kind: 'phase', text: `Wall cap ${maxWall}s reached; stopping the slice.` });
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 10000).unref();
}, maxWall * 1000);

child.on('close', (code) => {
  clearTimeout(wallTimer);
  const signals = collectJsonSignals(output);
  const ok = code === 0;
  finish({
    ok,
    reason: ok ? 'operate_complete' : 'operate_failed',
    member,
    executed: true,
    exit_code: code,
    max_wall_seconds: maxWall,
    needs_user: signals.needs_user,
    receipt_path: signals.receipt_path,
    summary: signals.summary,
  });
});

child.on('error', (error) => {
  clearTimeout(wallTimer);
  finish({ ok: false, reason: `operate_spawn_failed: ${error.message}`, member, executed: true });
});
