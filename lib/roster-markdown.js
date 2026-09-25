'use strict';

// ROSTER.md as text: which lines are job lines, which are team lines, and
// edits that touch one line while keeping everything else the person wrote
// (comments, order, blank lines, notes). What a line means (which engine,
// which job) lives in engine-registry; this file only knows the shape.

const ROSTER_MARKDOWN_TEMPLATE = [
  '# roster',
  '',
  '> edit any time. each line is job: engine and model, an optional effort (low, medium, high, xhigh, max), then optional "backup <engine and model>", "max 20 min", and "until 2026-10-24" (the year is required).',
  '',
];

function stripInlineComments(text) {
  return String(text || '').replace(/<!--.*?-->/g, '').trim();
}

// Sections: anything under a top heading, "## jobs", or "## roster" holds job
// lines; "## team" holds member lines; any other heading starts free notes
// that are never read as picks.
function sectionForHeading(level, title) {
  const name = String(title || '').trim().toLowerCase();
  if (level === 1) return 'jobs';
  if (name === 'team') return 'team';
  if (name === 'jobs' || name === 'roster') return 'jobs';
  return null;
}

function scanRosterMarkdown(text) {
  const source = String(text || '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const entries = [];
  const headings = [];
  let section = 'jobs';
  let inComment = false;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      return;
    }
    if (!line) return;
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      return;
    }
    if (line.startsWith('>') || line.startsWith('-') || line.startsWith('```')) return;
    const heading = /^(#{1,6})\s*(.*)$/.exec(line);
    if (heading) {
      section = sectionForHeading(heading[1].length, heading[2]);
      headings.push({ index, level: heading[1].length, section });
      return;
    }
    if (!section) return;
    const body = stripInlineComments(line);
    if (!body) return;
    const colon = body.indexOf(':');
    entries.push({
      index,
      lineNumber: index + 1,
      section,
      raw: line,
      name: colon > 0 ? body.slice(0, colon).trim() : '',
      value: colon > 0 ? body.slice(colon + 1).trim() : '',
      malformed: colon <= 0,
    });
  });
  return { lines, entries, headings, newline };
}

function joinLines(lines, newline) {
  const text = lines.join(newline);
  return text.endsWith(newline) ? text : `${text}${newline}`;
}

// Where a new line goes when no line for it exists yet: right after the last
// line of its section, else right after the section's heading.
function insertIndex(scan, section) {
  const inSection = scan.entries.filter((entry) => entry.section === section);
  if (inSection.length) return inSection[inSection.length - 1].index + 1;
  if (section === 'jobs') {
    const top = scan.headings.find((heading) => heading.section === 'jobs');
    if (!top) return 0;
    // Skip the blank line and any "> note" lines under the heading.
    let index = top.index + 1;
    while (index < scan.lines.length && (/^\s*$/.test(scan.lines[index]) || /^\s*>/.test(scan.lines[index]))) index += 1;
    return index;
  }
  const team = scan.headings.find((heading) => heading.section === 'team');
  return team ? team.index + 1 : -1;
}

// Set, replace, or remove one line. matches(entry) names the line; line is
// the new text, or null to remove every matching line.
function upsertRosterLine(text, { section = 'jobs', matches, line }) {
  const base = String(text || '').trim() ? String(text) : ROSTER_MARKDOWN_TEMPLATE.join('\n');
  const scan = scanRosterMarkdown(base);
  const lines = [...scan.lines];
  const hits = scan.entries.filter((entry) => entry.section === section && matches(entry));
  if (line === null) {
    for (const hit of [...hits].reverse()) lines.splice(hit.index, 1);
    return joinLines(trimTrailingBlank(lines), scan.newline);
  }
  if (hits.length) {
    const indent = /^\s*/.exec(lines[hits[0].index])[0];
    // A note the person left at the end of the line stays with it.
    const note = /(\s*<!--.*?-->\s*)$/.exec(lines[hits[0].index]);
    lines[hits[0].index] = `${indent}${line}${note ? note[1].replace(/\s+$/, '') : ''}`;
    return joinLines(trimTrailingBlank(lines), scan.newline);
  }
  const at = insertIndex(scan, section);
  if (at === -1) {
    const trimmed = trimTrailingBlank(lines);
    return joinLines([...trimmed, '', '## team', line], scan.newline);
  }
  lines.splice(at, 0, line);
  return joinLines(trimTrailingBlank(lines), scan.newline);
}

function trimTrailingBlank(lines) {
  const out = [...lines];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

// Replace every line for which rewrite(entry) returns a string, leaving the
// rest of the file byte for byte.
function rewriteRosterValues(text, rewrite) {
  const scan = scanRosterMarkdown(text);
  const lines = [...scan.lines];
  for (const entry of scan.entries) {
    const next = rewrite(entry);
    if (typeof next !== 'string') continue;
    const indent = /^\s*/.exec(lines[entry.index])[0];
    lines[entry.index] = `${indent}${next}`;
  }
  return joinLines(trimTrailingBlank(lines), scan.newline);
}

module.exports = {
  ROSTER_MARKDOWN_TEMPLATE,
  scanRosterMarkdown,
  upsertRosterLine,
  rewriteRosterValues,
};
