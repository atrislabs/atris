#!/usr/bin/env node
'use strict';

// Pareto-3 checklist quality score.
//
// Measures the three front doors a brand-new person actually hits, the way
// they would hit them: from an empty folder, with no context, reading only
// what the tool prints. Every point is earned by a live probe, never opinion.
//
//   1. onboard  - `atris init --yes` in a fresh folder
//   2. chat     - one real answered message through `ax`
//   3. mission  - the end-to-end loop drill in its own sandbox
//
// Rubric per feature (100 points):
//   cold start works, zero setup ......... 40
//   speed to first value ................. 20  (full marks at target, 0 at 4x)
//   plain language on the first screen ... 20  (fraction of clean lines)
//   graceful failure on wrong input ...... 20  (honest exit + plain reason,
//                                               no stack trace)
//
// Usage: node scripts/det/checklist-score.js [--json]

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const axPath = path.join(repoRoot, 'ax');
const { scanText } = require(path.join(repoRoot, 'lib', 'voice-gate'));

// System nouns a person with no idea should never have to decode on a first
// screen. Backticked command examples are exempt (they are copy targets).
const SYSTEM_NOUNS = /\b(?:verifier|worktree|subagent|jsonl|projection|runner[- ]profile|heartbeat|orchestrat\w+|frontmatter|monorepo)\b/i;
const STACK_FRAME = /^\s+at .+:\d+:\d+\)?$/;

function run(cmd, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs || 180000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...(options.env || {}) },
  });
  return {
    status: result.status,
    error: result.error || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ms: Date.now() - started,
  };
}

function speedPoints(ms, targetMs) {
  if (ms <= targetMs) return 20;
  const over = (ms - targetMs) / (targetMs * 3);
  return Math.max(0, Math.round(20 * (1 - over)));
}

function plainPoints(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30);
  if (!lines.length) return { points: 0, dirty: ['(no output at all)'] };
  const dirty = [];
  for (const line of lines) {
    // Command examples are copy targets, not prose; the reader with no idea
    // reads the description column, so scan only the human words.
    if (/^`.*`$/.test(line) || /^\$\s/.test(line) || /^(?:ax|atris|npx)\s/.test(line)) continue;
    const bare = line
      .replace(/`[^`]*`/g, '')
      .replace(/--[\w-]+/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/<[^>]*>/g, '');
    if (STACK_FRAME.test(line) || /\u2014/.test(bare) || SYSTEM_NOUNS.test(bare) || scanText(bare).length) {
      dirty.push(line.slice(0, 80));
    }
  }
  const clean = lines.length - dirty.length;
  return { points: Math.round((20 * clean) / lines.length), dirty };
}

function failurePoints(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  const honest = result.status !== 0 && !result.error;
  const noStack = !text.split(/\r?\n/).some((line) => STACK_FRAME.test(line))
    && !/\b(?:TypeError|ReferenceError|SyntaxError)\b/.test(text);
  const saysWhy = /\b(?:unknown|not found|no such|missing|usage|help|try|error)\b/i.test(text);
  let points = 0;
  if (honest) points += 8;
  if (noStack) points += 6;
  if (saysWhy) points += 6;
  return points;
}

function scoreOnboard(base) {
  const dir = fs.mkdtempSync(path.join(base, 'onboard-'));
  const cold = run(process.execPath, [cliPath, 'init', '--yes'], { cwd: dir });
  const artifact = fs.existsSync(path.join(dir, 'atris'));
  const coldPoints = cold.status === 0 && artifact ? 40 : 0;
  const plain = plainPoints(cold.stdout);
  const bad = run(process.execPath, [cliPath, 'definitely-not-a-command'], { cwd: dir });
  return {
    feature: 'onboard: atris init in an empty folder',
    dir,
    cold: coldPoints,
    speed: speedPoints(cold.ms, 10000),
    plain: plain.points,
    failure: failurePoints(bad),
    ms: cold.ms,
    dirty_lines: plain.dirty,
  };
}

function scoreChat(base, workspaceDir) {
  const cold = run(process.execPath, [axPath, '--fast', '--print', 'Reply with exactly: checklist-ok'], {
    cwd: workspaceDir,
    timeoutMs: 120000,
  });
  let answered = false;
  try {
    const payload = JSON.parse(cold.stdout.slice(cold.stdout.indexOf('{')));
    answered = payload.ok === true && /checklist-ok/.test(String(payload.output || ''));
  } catch {}
  const helpScreen = run(process.execPath, [axPath, '--help'], { cwd: workspaceDir, timeoutMs: 30000 });
  const plain = plainPoints(helpScreen.stdout);
  const bad = run(process.execPath, [axPath, '--fast', '--print'], { cwd: workspaceDir, timeoutMs: 30000 });
  return {
    feature: 'chat: one real answered message through ax',
    cold: cold.status !== null && answered ? 40 : 0,
    speed: speedPoints(cold.ms, 15000),
    plain: plain.points,
    failure: failurePoints(bad),
    ms: cold.ms,
    dirty_lines: plain.dirty,
  };
}

function scoreMission(base, workspaceDir) {
  const cold = run(process.execPath, [cliPath, 'drill', '--json'], { cwd: workspaceDir, timeoutMs: 300000 });
  let passed = false;
  let stages = 0;
  try {
    const payload = JSON.parse(cold.stdout.slice(cold.stdout.indexOf('{')));
    passed = payload.pass === true;
    stages = Array.isArray(payload.stages) ? payload.stages.length : 0;
  } catch {}
  const status = run(process.execPath, [cliPath, 'mission'], { cwd: workspaceDir, timeoutMs: 60000 });
  const plain = plainPoints(status.stdout);
  const bad = run(process.execPath, [cliPath, 'mission', 'run', '9999'], { cwd: workspaceDir, timeoutMs: 60000 });
  return {
    feature: `mission: full loop drill (${stages} stages) plus status screen`,
    cold: passed ? 40 : 0,
    speed: speedPoints(cold.ms, 90000),
    plain: plain.points,
    failure: failurePoints(bad),
    ms: cold.ms,
    dirty_lines: plain.dirty,
  };
}

function main() {
  const asJson = process.argv.includes('--json');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-checklist-'));
  const onboard = scoreOnboard(base);
  const chat = scoreChat(base, onboard.dir);
  const mission = scoreMission(base, onboard.dir);
  const features = [onboard, chat, mission].map((f) => ({
    ...f,
    total: f.cold + f.speed + f.plain + f.failure,
  }));
  const overall = Math.round(features.reduce((sum, f) => sum + f.total, 0) / features.length);
  const report = { schema: 'atris.checklist_score.v1', overall, features };
  fs.rmSync(base, { recursive: true, force: true });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('Pareto-3 checklist quality score\n');
  for (const f of features) {
    console.log(`  ${f.feature}`);
    console.log(`    cold start ${f.cold}/40 · speed ${f.speed}/20 (${(f.ms / 1000).toFixed(1)}s) · plain words ${f.plain}/20 · graceful failure ${f.failure}/20  =>  ${f.total}/100`);
    if (f.dirty_lines.length) console.log(`    lines that need plain words: ${f.dirty_lines.length}`);
  }
  console.log(`\n  overall: ${overall}/100`);
}

main();
