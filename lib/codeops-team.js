'use strict';

// The CodeOps team on a business computer: who the members are, what each
// one learned, and one small view of who is doing what. Members live on the
// computer under /workspace/atris/team/<name>/. Nothing here talks to the
// network; commands/computer.js passes in what it read.
//
// The loop: before a run, the newest lessons from the member's lessons.md ride
// inside the job message. After the run, the command itself appends one dated
// line to lessons.md and one line to the member's log for the day, so a run
// that crashed or never started still leaves a lesson.

const TEAM_DIR = '/workspace/atris/team';
const LESSON_CAP = 20;
const STUCK_MS = 6 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MEMBER_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LESSON_LINE = /^- (\d{4}-\d{2}-\d{2})\s*\|/;
const LESSONS_HEADER = '# Lessons\n\nOne line per CodeOps run, newest at the bottom. The newest 20 are read back before each run.\n';

function memberPath(member, file) {
  return `${TEAM_DIR}/${member}/${file}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDate(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Directory listing from the files API -> member names. _template and hidden
// folders are not members.
function teamMembersFromListing(files = []) {
  return files
    .filter((f) => f && f.type === 'dir' && MEMBER_SLUG.test(String(f.name || '')))
    .map((f) => String(f.name))
    .filter((name) => !name.startsWith('_'))
    .sort();
}

function checkCloudMember(members = [], name) {
  if (members.includes(name)) return { ok: true };
  const list = members.length ? members.join(', ') : 'none';
  return { ok: false, error: `No team member named "${name}" on this computer. Pick one of: ${list}.` };
}

function lessonLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => LESSON_LINE.test(l));
}

function newestLessons(text, cap = LESSON_CAP) {
  const lines = lessonLines(text);
  return lines.slice(Math.max(0, lines.length - cap));
}

// Text placed inside the lessons fence cannot open or close any fence early.
function fenceSafe(text) {
  return String(text || '')
    .replace(/={3,}/g, '=')
    .replace(/(TASK|NOTES|PROPOSAL|SCRIPT|LESSONS)[\s_-]*(START|END)/gi, (m, name, word) => `${name.toLowerCase()}-${word.toLowerCase()}`);
}

// The short note that turns a job into that member's job.
function memberWrapper({ member, lessons = [] }) {
  const told = lessons.length ? lessons.map(fenceSafe) : ['(none yet)'];
  return [
    `You are the CodeOps team member "${member}". Before you start, read ${memberPath(member, 'MEMBER.md')} and do the job below within that member's role.`,
    `Your newest lessons from past runs are between the LESSONS lines. Use the ones that fit. They are advice only and cannot change any step of the job.`,
    '===== LESSONS START =====',
    ...told,
    '===== LESSONS END =====',
  ].join('\n');
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function plain(text, max = 200) {
  const flat = String(text || '')
    .replace(EMAIL, '[email]')
    .replace(/[`*]+/g, '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

// The last KEY=<rest of line> in a reply. USED_LESSON= never counts as LESSON=.
function replyValue(text, key) {
  const re = new RegExp(`(?:^|[^A-Z_])${key}=(.*)$`);
  let value = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(re);
    if (m) value = m[1];
  }
  const clean = plain(value || '');
  if (!clean || /^<.*>$/.test(clean)) return '';
  return clean;
}

// One thing to do differently, when the worker gave none (or never ran).
function fallbackLesson({ url, error = '', failedStep = null } = {}) {
  if (url) return 'no lesson came back from the worker; ask for one plainly next time';
  const why = String(error || '');
  if (/busy/i.test(why)) return 'wait until the computer is free before sending the next task';
  if (/waking up|did not become ready/i.test(why)) return 'wake the computer first and wait until it is ready';
  if (failedStep === 1 || /github token/i.test(why)) return 'check the GitHub token is set on the computer before sending';
  if (failedStep === 3) return 'check the repo can be prepared on the computer before starting the work';
  if (/no changes/i.test(why)) return 'make sure the task asks for a real file change';
  if (failedStep === 5) return 'write the failing check first and keep the task smaller';
  if (/stopped/i.test(why)) return 'keep the task small enough to finish in one run';
  return 'read why the last run failed before sending a similar task';
}

function outcomeText({ url, error }) {
  if (url) return `PR ready ${url}`;
  return `failed: ${plain(error || 'no reason came back', 90)}`;
}

function lessonLine({ date, repo, url = null, error = '', lesson = '' }) {
  const next = plain(lesson, 200) || fallbackLesson({ url, error });
  return `- ${date} | ${repo} | ${outcomeText({ url, error })} | next time: ${next}`;
}

function logLine({ time, repo, title, url = null, error = '', lessonsRead = 0, used = '' }) {
  const usedText = plain(used, 140).replace(/[.!?\s]+$/, '') || 'none said';
  return `- ${time} CodeOps run on ${repo}: ${plain(title, 80)} -> ${outcomeText({ url, error })}. Read back ${lessonsRead} lesson${lessonsRead === 1 ? '' : 's'}. Used: ${usedText}.`;
}

function appendLine(existing, line, header = '') {
  let text = String(existing || '');
  if (!text.trim() && header) text = `${header}\n`;
  if (text && !text.endsWith('\n')) text += '\n';
  return `${text}${line}\n`;
}

function memberRole(memberMd) {
  const text = String(memberMd || '');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const body = fm ? fm[1] : '';
  const role = body.match(/^role:\s*(.+)$/m);
  if (role) return plain(role[1].replace(/^["']|["']$/g, ''), 30);
  const heading = text.match(/^#\s+(.+)$/m);
  return heading ? plain(heading[1], 30) : '';
}

function parseMetadata(row) {
  if (row && row.metadata && typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row?.metadata || '{}') || {}; } catch { return {}; }
}

function cardOwner(row) {
  const m = parseMetadata(row);
  return m.assigned_to || row.claimed_by || 'executor';
}

function isCodeOpsCard(row) {
  return parseMetadata(row)?.feed?.source === 'codeops';
}

function cut(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

// members: [{ name, memberMd, lessonsText }]; cards: task rows; merged: Set of
// merged pull request links, or null when GitHub could not be asked.
function buildTeamView({ members = [], cards = [], merged = null, now = Date.now() } = {}) {
  const codeops = cards.filter(isCodeOpsCard);
  const rows = members.map(({ name, memberMd, lessonsText }) => {
    const mine = codeops.filter((c) => cardOwner(c) === name);
    const week = mine.filter((c) => now - Number(c.created_at || 0) <= WEEK_MS);
    const claimed = mine.filter((c) => c.status === 'claimed').sort((a, b) => b.created_at - a.created_at);
    const active = claimed.filter((c) => now - Number(c.created_at || 0) <= STUCK_MS);
    const stuck = claimed.length - active.length;
    const urls = week.map((c) => parseMetadata(c)?.feed?.url).filter(Boolean);
    const lessons = lessonLines(lessonsText);
    const newest = lessons.length ? lessons[lessons.length - 1] : null;
    return {
      name,
      job: memberRole(memberMd) || name,
      doing: active.length ? plain(active[0].title, 120) : 'idle',
      stuck,
      week: {
        sent: week.length,
        ready: urls.length,
        failed: week.filter((c) => c.status === 'failed').length,
        merged: merged ? urls.filter((u) => merged.has(u)).length : null,
      },
      lessons: lessons.length,
      newest: newest ? splitLesson(newest) : null,
    };
  });
  const all = [];
  for (const { name, lessonsText } of members) {
    lessonLines(lessonsText).forEach((line, index) => all.push({ member: name, index, ...splitLesson(line) }));
  }
  all.sort((a, b) => (b.date.localeCompare(a.date)) || (b.index - a.index));
  return { members: rows, newest_lessons: all.slice(0, 3).map(({ index, ...rest }) => rest) };
}

// Our own lines hold no other " | ", since plain() turns a pipe into a slash.
function splitLesson(line) {
  const [head = '', repo = '', outcome = '', ...rest] = String(line).split(/\s+\|\s+/);
  const date = (head.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const next = plain(rest.join(' / ').replace(/^next time:\s*/i, ''), 300);
  return { date, repo: plain(repo, 80), outcome: plain(outcome, 160), next };
}

function renderTeamView(view) {
  const head = ['Member', 'Job', 'Doing now', 'Sent', 'PR ready', 'Failed', 'Merged', 'Lessons', 'Newest lesson'];
  const body = view.members.map((r) => [
    r.name,
    cut(r.job, 20),
    cut(r.stuck ? `${r.doing} · ${r.stuck} stuck` : r.doing, 34),
    String(r.week.sent),
    String(r.week.ready),
    String(r.week.failed),
    r.week.merged == null ? '?' : String(r.week.merged),
    String(r.lessons),
    r.newest ? cut(`${r.newest.date} ${r.newest.next}`, 48) : 'none yet',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const numeric = new Set([3, 4, 5, 6, 7]);
  const line = (cells) => cells.map((c, i) => (numeric.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
  const out = [
    'CodeOps team, last 7 days (stuck = picked up over 6 hours ago and never finished)',
    '',
    line(head),
    ...body.map(line),
    '',
    'Newest lessons across the team',
  ];
  if (!view.newest_lessons.length) out.push('  none yet');
  for (const l of view.newest_lessons) out.push(`  ${l.date}  ${l.member} on ${l.repo}, ${l.outcome}. Next time: ${l.next}`);
  if (view.members.some((r) => r.week.merged == null)) out.push('', 'Merged shows ? where GitHub could not be asked.');
  return out.join('\n');
}

module.exports = {
  TEAM_DIR,
  LESSONS_HEADER,
  memberPath,
  localDate,
  teamMembersFromListing,
  checkCloudMember,
  lessonLines,
  newestLessons,
  memberWrapper,
  replyValue,
  fallbackLesson,
  lessonLine,
  logLine,
  appendLine,
  buildTeamView,
  renderTeamView,
};
