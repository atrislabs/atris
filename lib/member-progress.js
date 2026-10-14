'use strict';

// Live progress for a working member: one plain line per tool step, printed to
// stderr and appended to <dir>/<member>.log so another shell can tail it.

const fs = require('fs');
const os = require('os');
const path = require('path');

function realish(p) {
  try { return fs.realpathSync(p); } catch {}
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch {}
  return p;
}

function insideRel(cwd, p) {
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

// Relative to cwd when inside it; symlinked roots (macOS /var vs /private/var)
// still count as inside.
function relativeTo(cwd, file) {
  const p = String(file || '');
  if (!p || !cwd || !path.isAbsolute(p)) return p;
  return insideRel(cwd, p) || insideRel(realish(cwd), realish(p)) || p;
}

function formatToolStep(block, cwd) {
  if (!block || block.type !== 'tool_use') return null;
  const name = String(block.name || 'tool');
  const input = block.input || {};
  switch (name) {
    case 'Read':
      return `reading ${relativeTo(cwd, input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `editing ${relativeTo(cwd, input.file_path)}`;
    case 'Bash': {
      const first = String(input.command || '').split('\n')[0].trim();
      return `running: ${first.slice(0, 70)}`;
    }
    case 'Grep':
      return `searching for ${input.pattern || ''}`;
    case 'Glob':
      return `finding ${input.pattern || ''}`;
    default:
      return name.toLowerCase();
  }
}

function progressDir() {
  return process.env.ATRIS_PROGRESS_DIR || path.join(os.homedir(), '.atris', 'progress');
}

function safeMember(member) {
  return String(member || 'mission').replace(/[^A-Za-z0-9._-]/g, '_') || 'mission';
}

function hhmm(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function appendProgress(member, line, missionId) {
  // Test runs never write into the real home folder unless they name a dir.
  if (!process.env.ATRIS_PROGRESS_DIR && process.env.NODE_TEST_CONTEXT) return;
  try {
    const dir = progressDir();
    fs.mkdirSync(dir, { recursive: true });
    const entry = `${new Date().toISOString()} ${missionId || '-'} ${line}\n`;
    fs.appendFileSync(path.join(dir, `${safeMember(member)}.log`), entry, 'utf8');
  } catch {}
}

// Print one step for the operator and keep it in the member's progress log.
function reportProgress(member, line, missionId) {
  try { process.stderr.write(`  ${member || 'mission'} ${hhmm()}  ${line}\n`); } catch {}
  appendProgress(member, line, missionId);
}

module.exports = { formatToolStep, appendProgress, reportProgress };
