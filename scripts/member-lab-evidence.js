#!/usr/bin/env node
// Evidence behavior for member-lab runs. For each scored row in
// <lab>/results/<label>.jsonl, find the agent's Claude transcript (by the
// workspace or member worktree path), and measure what the doctrine targets:
// did the agent run the real thing, did it hide exit codes behind a pipe, did
// it edit after its last run, and what its final report said.
//
// usage: node scripts/member-lab-evidence.js --lab <dir> [--labels a,b]
//          [--out runs.jsonl]
// Prints one JSON row per run (or writes them to --out).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Claude Code names a project folder after its cwd with every
// non-alphanumeric character turned into '-'.
function encode(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

// A command that runs the project's own code or tests (not git, not atris).
const RUN = /(^|[\s;&|(])(node\s+(--test\b|[^\s-][^\s]*\.(c|m)?js\b)|npm\s+(run\s+)?test\b|npx\s+(jest|vitest|mocha)\b|bash\s+\S+\.sh\b|\.\/\S+\.sh\b|python3?\s+\S+\.py\b|pytest\b)/;
// A pipe into a filter that throws away the left side's exit status.
const MASK = /[^|]\|\s*(tail|head|grep|sed|awk|wc|cut|sort|less|cat)\b/;

function segments(cmd) {
  // Split on && ; || and newlines, keep pipes inside a segment.
  return String(cmd).split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
}

function isRun(cmd) {
  return segments(cmd).some((s) => RUN.test(s) && !/^\s*(atris|git)\b/.test(s));
}

function isMaskedRun(cmd) {
  if (/pipefail|PIPESTATUS/.test(cmd)) return false;
  return segments(cmd).some((s) => RUN.test(s) && MASK.test(s) && !/^\s*(atris|git)\b/.test(s));
}

const DESK = /(^|\/)(atris|\.atris|\.claude|\.cursor|\.devin|logs)\/|(^|\/)(AGENTS|CLAUDE)\.md$|\.cursorrules$/;

function readSession(file) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  const first = rows.find((r) => r.type === 'user' && typeof r.message?.content === 'string');
  const prompt = first ? first.message.content : '';
  const steps = [];
  let finalText = '';
  for (const r of rows) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    const texts = [];
    for (const c of r.message.content) {
      if (c.type === 'tool_use') {
        if (c.name === 'Bash') steps.push({ kind: 'bash', cmd: String(c.input?.command || '') });
        else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) steps.push({ kind: 'edit', file: String(c.input?.file_path || c.input?.notebook_path || '') });
      } else if (c.type === 'text' && c.text.trim()) {
        texts.push(c.text);
      }
    }
    if (texts.length) finalText = texts.join('\n');
  }
  return { file, prompt, steps, finalText, mtime: fs.statSync(file).mtimeMs };
}

function sessionsFor(runsRoot, task) {
  if (!fs.existsSync(PROJECTS)) return [];
  const real = fs.existsSync(runsRoot) ? fs.realpathSync(runsRoot) : runsRoot;
  const inPlace = encode(path.join(real, task));
  const worktree = `${encode(path.join(real, '.agent-worktrees', task))}-`;
  const dirs = fs.readdirSync(PROJECTS).filter((d) => d === inPlace || d.startsWith(worktree));
  const out = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(PROJECTS, d))) {
      if (f.endsWith('.jsonl')) out.push(readSession(path.join(PROJECTS, d, f)));
    }
  }
  // The worker is the session handed the mission tick; others are reviewers.
  return out.filter((s) => /Mission Tick/.test(s.prompt)).sort((a, b) => a.mtime - b.mtime);
}

function measure(sessions) {
  const steps = sessions.flatMap((s) => s.steps);
  const runs = [];
  const edits = [];
  steps.forEach((s, i) => {
    if (s.kind === 'bash' && isRun(s.cmd)) runs.push(i);
    if (s.kind === 'edit' && s.file && !DESK.test(s.file)) edits.push(i);
  });
  const masked = steps.filter((s) => s.kind === 'bash' && isMaskedRun(s.cmd)).length;
  const lastRun = runs.length ? runs[runs.length - 1] : -1;
  const lastEdit = edits.length ? edits[edits.length - 1] : -1;
  return {
    sessions: sessions.length,
    bash: steps.filter((s) => s.kind === 'bash').length,
    real_runs: runs.length,
    masked_runs: masked,
    last_run_masked: lastRun > -1 && isMaskedRun(steps[lastRun].cmd),
    source_edits: edits.length,
    ran_before_first_edit: edits.length > 0 && runs.length > 0 && runs[0] < edits[0],
    edited_after_last_run: lastEdit > -1 && lastEdit > lastRun,
    final_report: sessions.length ? sessions[sessions.length - 1].finalText : '',
    commands: steps.filter((s) => s.kind === 'bash').map((s) => s.cmd.slice(0, 240)),
  };
}

function measureLab(lab, wanted = null) {
  const resultsDir = path.join(lab, 'results');
  const out = [];
  if (!fs.existsSync(resultsDir)) return out;
  for (const f of fs.readdirSync(resultsDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const label = f.replace(/\.jsonl$/, '');
    if (wanted && !wanted.includes(label)) continue;
    const rows = fs.readFileSync(path.join(resultsDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const row of rows) {
      const sessions = sessionsFor(path.join(lab, 'runs', label), row.task);
      out.push({ label, task: row.task, passed: row.passed, secs: row.secs, ...measure(sessions) });
    }
  }
  return out;
}

function main() {
  const lab = path.resolve(flag('lab', path.join(os.tmpdir(), 'atris-member-lab')));
  const wanted = flag('labels', '') ? flag('labels', '').split(',') : null;
  const out = measureLab(lab, wanted);
  const text = out.map((r) => JSON.stringify(r)).join('\n') + (out.length ? '\n' : '');
  if (flag('out', '')) fs.writeFileSync(flag('out', ''), text);
  else process.stdout.write(text);
}

if (require.main === module) main();

module.exports = { isRun, isMaskedRun, encode, measure, measureLab };
