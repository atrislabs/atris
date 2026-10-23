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
const ROSTER_NOTE = '> edit any time. each "## job" lists its workers in order, one per line: "- tool, model: name", then optional "effort: medium", "max: 20 min", "prep: search" (that job reads the task first and hands this worker a short brief), and "until 2026-10-24" (the year is required). the first ready worker leads and the rest back it up.';

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
// job whose "- " lines are its workers. "## picks" holds the owner's short
// list of models, one "- tool · model" per line. Other lines under a job heading are
// free notes that are never read as picks.
function sectionForHeading(level, title) {
  const name = String(title || '').trim().toLowerCase();
  if (level === 1) return 'jobs';
  if (name === 'team') return 'team';
  if (name === 'picks') return 'picks';
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
    // Under picks, each "- " line is one model on the owner's short list;
    // other lines there are notes.
    if (section === 'picks') {
      if (dashed) entries.push({ index, lineNumber: index + 1, section, raw: line, name: '', value: body, dashed, malformed: false });
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

// Two headings say the same thing when they differ only in case or spacing.
function sameHeading(a, b) {
  const plain = (text) => stripInlineComments(String(text || '').replace(/^#+\s*/, '')).replace(/\s+/g, ' ').toLowerCase();
  return plain(a) === plain(b);
}

// Replace one job's worker lines with lines (in order), add the section when
// it is missing, or remove every section for the job when lines is null. matches(title)
// names the section by its heading; heading is the text for a new one, and
// when given it also replaces an existing heading that says something else
// (a note at the end of the old heading stays). Every other line outside that
// job's workers stays as written.
function replaceJobSection(text, { matches, heading, lines: workerLines }) {
  const base = String(text || '').trim() ? String(text) : ROSTER_MARKDOWN_TEMPLATE.join('\n');
  const scan = scanRosterMarkdown(base);
  const lines = [...scan.lines];
  const sections = jobSections(scan).filter((entry) => matches(entry.heading.title));
  const section = sections[0];
  if (section && workerLines === null) {
    // Every section for the job goes, last first so earlier indexes hold; a
    // second section that was ignored must not become the job.
    for (const entry of [...sections].reverse()) {
      let start = entry.heading.index;
      let end = Math.min(entry.end, lines.length);
      // Take the blank lines after the section with it, so no double gap stays.
      while (end > start && isBlank(lines[end - 1])) end -= 1;
      while (end < lines.length && isBlank(lines[end])) end += 1;
      if (end >= lines.length) while (start > 0 && isBlank(lines[start - 1])) start -= 1;
      lines.splice(start, end - start);
    }
    return joinLines(trimTrailingBlank(lines), scan.newline);
  }
  if (section) {
    const at = section.workers.length ? section.workers[0].index : section.heading.index + 1;
    for (const worker of [...section.workers].reverse()) lines.splice(worker.index, 1);
    lines.splice(at, 0, ...workerLines);
    if (heading && !sameHeading(section.heading.raw, heading)) {
      const note = /\s*(<!--.*?-->)\s*$/.exec(section.heading.raw);
      lines[section.heading.index] = note ? `${heading} ${note[1]}` : heading;
    }
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

// Set one member's line under "## team" to "- member: value": the member's
// first line is replaced in place (indent and an end note kept); a member
// with no line is added after the last team line, or under the team heading,
// or in a new team section at the end. Every other line stays as written.
function replaceTeamLine(text, member, value) {
  const base = String(text || '').trim() ? String(text) : ROSTER_MARKDOWN_TEMPLATE.join('\n');
  const scan = scanRosterMarkdown(base);
  const lines = [...scan.lines];
  const name = String(member || '').trim().toLowerCase();
  const line = `- ${name}: ${value}`;
  const team = scan.entries.filter((entry) => entry.section === 'team' && !entry.malformed);
  const mine = team.find((entry) => entry.name.trim().toLowerCase() === name);
  if (mine) {
    const indent = /^\s*/.exec(lines[mine.index])[0];
    const note = /\s*(<!--.*?-->)\s*$/.exec(mine.raw);
    lines[mine.index] = `${indent}${line}${note ? ` ${note[1]}` : ''}`;
    return joinLines(trimTrailingBlank(lines), scan.newline);
  }
  const heading = scan.headings.find((entry) => entry.section === 'team');
  if (heading) {
    const next = scan.headings.find((entry) => entry.index > heading.index);
    const under = team.filter((entry) => entry.index > heading.index && (!next || entry.index < next.index));
    lines.splice(under.length ? under[under.length - 1].index + 1 : heading.index + 1, 0, line);
    return joinLines(trimTrailingBlank(lines), scan.newline);
  }
  const trimmed = trimTrailingBlank(lines);
  return joinLines([...trimmed, ...(trimmed.length ? [''] : []), '## team', line], scan.newline);
}

module.exports = {
  OLD_ROSTER_NOTE,
  ROSTER_NOTE,
  ROSTER_MARKDOWN_TEMPLATE,
  scanRosterMarkdown,
  jobSections,
  replaceJobSection,
  replaceTeamLine,
  rewriteRosterValues,
  joinLines,
};
