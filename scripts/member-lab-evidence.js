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
const NOT_PROJECT = /^\s*(atris|git)\b/;

// Heredoc bodies are file content, not commands; keep only the opening line.
function stripHeredocs(cmd) {
  return String(cmd).replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '$1');
}

function segments(cmd) {
  // Split on && ; || and newlines, keep pipes inside a segment.
  return stripHeredocs(cmd).split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
}

function segIsRun(seg) {
  return RUN.test(seg) && !NOT_PROJECT.test(seg);
}

// The Bash tool runs the user's shell (zsh here): `set -o pipefail` and zsh's
// lowercase `pipestatus` keep a piped exit code; bash's PIPESTATUS is empty
// under zsh, so it does not.
function keepsPipeStatus(cmd) {
  return /pipefail|\bpipestatus\b/.test(cmd);
}

function segIsMasked(seg, cmd) {
  return segIsRun(seg) && MASK.test(seg) && !keepsPipeStatus(cmd);
}

const DESK = /(^|\/)(atris|\.atris|\.claude|\.cursor|\.devin|logs)\/|(^|\/)(AGENTS|CLAUDE)\.md$|\.cursorrules$/;
const SCRATCH = /^(\/dev\/|\/tmp\/|\/private\/|\$TMPDIR|&)/;

// The file a shell segment writes, if any: sed -i, perl -i, tee, or a
// redirect that is not scratch output.
function segEditTarget(seg) {
  if (NOT_PROJECT.test(seg)) return '';
  const tokens = seg.split(/\s+/);
  if (/\bsed\s+(-[a-zA-Z]*i\b|--in-place)|\bperl\s+-[a-z]*i/.test(seg)) return tokens[tokens.length - 1].replace(/['"]/g, '');
  const tee = seg.match(/\btee\s+(?:-a\s+)?([^\s|;&]+)/);
  if (tee && !SCRATCH.test(tee[1])) return tee[1];
  const redirect = seg.match(/(?:^|[^0-9&>])>>?\s*([^\s|;&]+)/);
  if (redirect && !SCRATCH.test(redirect[1])) return redirect[1].replace(/['"]/g, '');
  return '';
}

function isRun(cmd) {
  return segments(cmd).some(segIsRun);
}

function isMaskedRun(cmd) {
  return segments(cmd).some((s) => segIsMasked(s, cmd));
}

function readSession(file) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  const first = rows.find((r) => r.type === 'user' && typeof r.message?.content === 'string');
  const prompt = first ? first.message.content : '';
  const stamped = rows.find((r) => r.timestamp);
  const startedAt = stamped ? Date.parse(stamped.timestamp) : fs.statSync(file).mtimeMs;
  const steps = [];
  const commands = [];
  let finalText = '';
  for (const r of rows) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    const texts = [];
    for (const c of r.message.content) {
      if (c.type === 'tool_use') {
        if (c.name === 'Bash') {
          const cmd = String(c.input?.command || '');
          commands.push(cmd);
          for (const seg of segments(cmd)) {
            const target = segEditTarget(seg);
            if (target) steps.push({ kind: 'edit', file: target });
            if (segIsRun(seg)) steps.push({ kind: 'run', masked: segIsMasked(seg, cmd) });
          }
        } else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) {
          steps.push({ kind: 'edit', file: String(c.input?.file_path || c.input?.notebook_path || '') });
        }
      } else if (c.type === 'text' && c.text.trim()) {
        texts.push(c.text);
      }
    }
    if (texts.length) finalText = texts.join('\n');
  }
  return { file, prompt, steps, commands, finalText, startedAt };
}

function sessionsFor(runsRoot, task, sinceMs = 0) {
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
  // Sessions from an earlier attempt at the same folder are left out.
  return out.filter((s) => /Mission Tick/.test(s.prompt) && s.startedAt >= sinceMs)
    .sort((a, b) => a.startedAt - b.startedAt);
}

function measure(sessions) {
  const steps = sessions.flatMap((s) => s.steps);
  const runs = [];
  const edits = [];
  steps.forEach((s, i) => {
    if (s.kind === 'run') runs.push(i);
    if (s.kind === 'edit' && s.file && !DESK.test(s.file)) edits.push(i);
  });
  const lastRun = runs.length ? runs[runs.length - 1] : -1;
  const lastEdit = edits.length ? edits[edits.length - 1] : -1;
  return {
    sessions: sessions.length,
    bash: sessions.reduce((n, s) => n + (s.commands || []).length, 0),
    real_runs: runs.length,
    masked_runs: steps.filter((s) => s.kind === 'run' && s.masked).length,
    last_run_masked: lastRun > -1 && steps[lastRun].masked === true,
    source_edits: edits.length,
    ran_before_first_edit: edits.length > 0 && runs.length > 0 && runs[0] < edits[0],
    edited_after_last_run: lastEdit > -1 && lastEdit > lastRun,
    final_report: sessions.length ? sessions[sessions.length - 1].finalText : '',
    commands: sessions.flatMap((s) => s.commands || []),
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
      // A row is written when its run ends; the run began secs (plus setup) before.
      const since = row.at && row.secs ? Date.parse(row.at) - (row.secs + 300) * 1000 : 0;
      const sessions = sessionsFor(path.join(lab, 'runs', label), row.task, since);
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

module.exports = { isRun, isMaskedRun, segEditTarget, encode, measure, measureLab };
