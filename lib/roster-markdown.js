'use strict';

// ROSTER.md as text: which lines are job lines, worker lines, and team
// lines, and edits that touch one job while keeping everything else the
// person wrote (comments, order, blank lines, notes). What a line means
// (which engine, which job) lives in engine-registry; this file only knows
// the shape.
//
// Two shapes read side by side. The sectioned shape, which assign writes:
//   ## build
//   - claude code, model: opus 5.5
//   - codex, effort: medium
// and the older one-line shape, still read as before:
//   build: claude opus 5.5, backup codex

const OLD_ROSTER_NOTE = '> edit any time. each line is job: engine and model, an optional effort (low, medium, high, xhigh, max), then optional "backup <engine and model>", "max 20 min", and "until 2026-10-24" (the year is required).';
const ROSTER_NOTE = '> edit any time. each "## job" lists its workers in order, one per line: "- tool, model: name", then optional "effort: medium", "max: 20 min", and "until 2026-10-24" (the year is required). the first ready worker leads and the rest back it up.';

const ROSTER_MARKDOWN_TEMPLATE = [
  '# roster',
  '',
  ROSTER_NOTE,
  '',
];

function stripInlineComments(text) {
  return String(text || '').replace(/<!--.*?-->/g, '').trim();
}

// Sections: anything under a top heading, "## jobs", or "## roster" holds
// one-line job lines; "## team" holds member lines; any other heading is a
// job whose "- " lines are its workers. Other lines under a job heading are
// free notes that are never read as picks.
function sectionForHeading(level, title) {
  const name = String(title || '').trim().toLowerCase();
  if (level === 1) return 'jobs';
  if (name === 'team') return 'team';
  if (name === 'jobs' || name === 'roster') return 'jobs';
  return 'job';
}

function scanRosterMarkdown(text) {
  const source = String(text || '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const entries = [];
  const headings = [];
  let section = 'jobs';
  let heading = null;
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
    if (line.startsWith('>') || line.startsWith('```')) return;
    const headingMatch = /^(#{1,6})\s*(.*)$/.exec(line);
    if (headingMatch) {
      section = sectionForHeading(headingMatch[1].length, headingMatch[2]);
      heading = { index, lineNumber: index + 1, level: headingMatch[1].length, title: stripInlineComments(headingMatch[2]), raw: line, section };
      headings.push(heading);
      return;
    }
    const dashed = /^-\s+/.test(line);
    if (line.startsWith('-') && !dashed) return;
    const body = stripInlineComments(dashed ? line.replace(/^-\s+/, '') : line);
    if (!body) return;
    if (section === 'job') {
      // Only "- " lines under a job heading are workers.
      if (!dashed) return;
      entries.push({ index, lineNumber: index + 1, section, raw: line, name: '', value: body, heading: heading.title, headingIndex: heading.index, dashed, malformed: false });
      return;
    }
    // A "- " bullet under the jobs heading is a note; under team it is a
    // member line.
    if (dashed && section !== 'team') return;
    const colon = body.indexOf(':');
    if (dashed && colon <= 0) return;
    entries.push({
      index,
      lineNumber: index + 1,
      section,
      raw: line,
      name: colon > 0 ? body.slice(0, colon).trim() : '',
      value: colon > 0 ? body.slice(colon + 1).trim() : '',
      dashed,
      malformed: colon <= 0,
    });
  });
  return { lines, entries, headings, newline };
}

function joinLines(lines, newline) {
  const text = lines.join(newline);
  return text.endsWith(newline) ? text : `${text}${newline}`;
}

function trimTrailingBlank(lines) {
  const out = [...lines];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function isBlank(line) {
  return !String(line || '').trim();
}

// One job's section: its heading, the index where it ends (the next heading
// or the end of the file), and its worker lines in order.
function jobSections(scan) {
  return scan.headings
    .map((heading, i) => ({ heading, next: scan.headings[i + 1] }))
    .filter(({ heading }) => heading.section === 'job')
    .map(({ heading, next }) => ({
      heading,
      end: next ? next.index : scan.lines.length,
      workers: scan.entries.filter((entry) => entry.section === 'job' && entry.headingIndex === heading.index),
    }));
}

// Replace one job's worker lines with lines (in order), add the section when
// it is missing, or remove the whole section when lines is null. matches(title)
// names the section by its heading; heading is the text for a new one. Every
// line outside that job's workers stays as written.
function replaceJobSection(text, { matches, heading, lines: workerLines }) {
  const base = String(text || '').trim() ? String(text) : ROSTER_MARKDOWN_TEMPLATE.join('\n');
  const scan = scanRosterMarkdown(base);
  const lines = [...scan.lines];
  const section = jobSections(scan).find((entry) => matches(entry.heading.title));
  if (section && workerLines === null) {
    let start = section.heading.index;
    let end = section.end;
    // Take the blank lines after the section with it, so no double gap stays.
    while (end > start && isBlank(lines[end - 1])) end -= 1;
    while (end < lines.length && isBlank(lines[end])) end += 1;
    if (end >= lines.length) while (start > 0 && isBlank(lines[start - 1])) start -= 1;
    lines.splice(start, end - start);
    return joinLines(trimTrailingBlank(lines), scan.newline);
  }
  if (section) {
    const at = section.workers.length ? section.workers[0].index : section.heading.index + 1;
    for (const worker of [...section.workers].reverse()) lines.splice(worker.index, 1);
    lines.splice(at, 0, ...workerLines);
    return joinLines(trimTrailingBlank(lines), scan.newline);
  }
  if (workerLines === null) return joinLines(trimTrailingBlank(lines), scan.newline);
  // A new job goes right before the team, else at the end.
  const team = scan.headings.find((entry) => entry.section === 'team');
  const block = [heading, ...workerLines];
  if (team) {
    let at = team.index;
    while (at > 0 && isBlank(lines[at - 1])) at -= 1;
    lines.splice(at, 0, ...(at > 0 ? [''] : []), ...block);
    return joinLines(trimTrailingBlank(lines), scan.newline);
  }
  const trimmed = trimTrailingBlank(lines);
  return joinLines([...trimmed, ...(trimmed.length ? [''] : []), ...block], scan.newline);
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
  OLD_ROSTER_NOTE,
  ROSTER_NOTE,
  ROSTER_MARKDOWN_TEMPLATE,
  scanRosterMarkdown,
  jobSections,
  replaceJobSection,
  rewriteRosterValues,
  joinLines,
};
