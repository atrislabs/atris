'use strict';

const { extractJson } = require('./security-audit');

// The project's own wall of shame (atris/SPEC.md, qm-compatible): each
// `### Lens (flags)` heading under `## Wall of shame` is one recurring mistake.

const START = '<!-- atris-code-review:start -->';
const END = '<!-- atris-code-review:end -->';
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'Package.resolved', 'poetry.lock']);
const VERDICTS = new Set(['accept', 'request changes']);

function splitLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n');
}

function parseHeading(line) {
  const head = line.slice(4).trim();
  const open = head.indexOf(' (');
  const name = (open < 0 ? head : head.slice(0, open)).trim();
  const flags = open < 0 ? [] : head.slice(open + 2).replace(/\)$/, '').split(',').map((f) => f.trim()).filter(Boolean);
  return { name, flags };
}

function parseSpec(text) {
  const lines = splitLines(text);
  const start = lines.findIndex((line) => line.trim() === '## Wall of shame');
  if (start < 0) return null;
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const end = next < 0 ? lines.length : next;
  const lenses = [];
  for (let i = start + 1; i < end; i += 1) {
    if (!lines[i].startsWith('### ')) continue;
    const { name, flags } = parseHeading(lines[i]);
    const lower = flags.map((f) => f.toLowerCase());
    const on = lower.find((f) => f.startsWith('reviewed on '));
    lenses.push({
      name,
      flags,
      line: i,
      always: lower.includes('always reviewed'),
      ci: lower.includes('checked by ci'),
      model: on ? on.slice('reviewed on '.length) : '',
    });
  }
  lenses.forEach((lens, k) => {
    lens.end = k + 1 < lenses.length ? lenses[k + 1].line : end;
    lens.text = lines.slice(lens.line, lens.end).join('\n').trim();
  });
  return { lines, lenses };
}

// Same rule as qm's wall-of-shame check, over `git apply --numstat` output.
function overTesting(numstat) {
  let tests = 0;
  let source = 0;
  for (const row of splitLines(numstat)) {
    const [added, removed, ...rest] = row.split('\t');
    if (removed === undefined) continue;
    const dirs = rest.join('\t').split('/');
    const name = dirs.pop();
    if (name.includes('.test.') || dirs.some((d) => d === 'test' || d === 'tests' || d.endsWith('Tests'))) {
      tests += (Number(added) || 0) - (Number(removed) || 0);
    } else if (!name.endsWith('.md') && !LOCKFILES.has(name)) {
      source += Number(added) || 0;
    }
  }
  const ok = tests <= source;
  return {
    verdict: ok ? 'accept' : 'request changes',
    assessment: `net test lines ${tests}, source lines added ${source}.${ok ? '' : ' Remove or reshape tests until they do not exceed source.'}`,
  };
}

function parseVerdict(text) {
  const data = extractJson(text, (v) => 'verdict' in v);
  if (!data) return { error: 'answer held no JSON verdict' };
  const verdict = String(data.verdict || '').trim().toLowerCase().replace(/_/g, ' ');
  const score = Number(data.score);
  const assessment = String(data.assessment || '').trim();
  if (!VERDICTS.has(verdict)) return { error: `verdict "${data.verdict}" is not accept or request changes` };
  if (!Number.isInteger(score) || score < 0 || score > 100) return { error: `score "${data.score}" is not a whole number from 0 to 100` };
  if (!assessment) return { error: 'assessment was empty' };
  return { verdict, score, assessment };
}

// Triage marks lenses not relevant; any lens it skips or garbles stays in.
function parseTriage(text, names) {
  const data = extractJson(text, (v) => Array.isArray(v.lenses));
  if (!data) return null;
  const skip = new Map();
  for (const row of data.lenses) {
    if (!row || row.relevant !== false) continue;
    const name = names.find((n) => n.toLowerCase() === String(row.lens || '').trim().toLowerCase());
    if (name) skip.set(name, String(row.reason || 'triage found nothing for this lens').trim());
  }
  return skip;
}

const LABELS = { accept: 'Accept', 'request changes': 'Request changes', 'not relevant': 'Not relevant', 'no verdict': 'No verdict' };

function cell(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function reportBlock(rows, { sha, dirty }) {
  return [
    START,
    '## Wall of shame review report',
    '',
    `Reviewed commit: \`${sha}\`${dirty ? ' plus uncommitted changes' : ''}`,
    '',
    '| Lens | Reviewer | Verdict | Score | Assessment |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.lens)} | ${cell(r.reviewer)} | ${LABELS[r.verdict]} | ${Number.isInteger(r.score) ? `${r.score}/100` : '-'} | ${cell(r.assessment)} |`),
    END,
  ].join('\n');
}

function upsertBlock(body, block) {
  const text = String(body || '');
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + END.length);
  return `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${block}\n`;
}

// One dated example bullet at the end of the lens's section; the example count
// in the heading follows. Nothing a person wrote is changed.
function addExample(text, lensName, example, date) {
  const spec = parseSpec(text);
  if (!spec) return { error: 'atris/SPEC.md has no "## Wall of shame" section' };
  const lens = spec.lenses.find((l) => l.name.toLowerCase() === String(lensName).trim().toLowerCase());
  if (!lens) return { error: `no lens named "${lensName}". Lenses: ${spec.lenses.map((l) => l.name).join(', ')}` };
  const lines = spec.lines.slice();
  let last = lens.end - 1;
  while (last > lens.line && !lines[last].trim()) last -= 1;
  lines.splice(last + 1, 0, ...(lines[last].startsWith('- ') ? [] : ['']), `- ${example.trim()} (${date})`);
  const count = lens.flags.findIndex((f) => /^\d+ examples?$/.test(f));
  if (count >= 0) {
    const n = Number.parseInt(lens.flags[count], 10) + 1;
    const flags = lens.flags.slice();
    flags[count] = `${n} example${n === 1 ? '' : 's'}`;
    lines[lens.line] = `### ${lens.name} (${flags.join(', ')})`;
  }
  return { text: lines.join('\n'), lens: lens.name };
}

module.exports = { parseSpec, overTesting, parseVerdict, parseTriage, reportBlock, upsertBlock, addExample, LABELS };
