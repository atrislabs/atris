'use strict';

// The start-up screen in whole sentences. A person who has never seen the
// project, or an agent starting cold, should read each paragraph once and
// know what happened, why it matters and how we know. No scores without a
// meaning, no task codes, no labels a reader has to decode.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A job nobody has touched in this long is stuck, not in progress.
const STUCK_AFTER_MS = 3 * DAY_MS;
const WIDTH = 74;

function wrap(text, { width = WIDTH, indent = '  ', hang = '' } = {}) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const lead = lines.length ? indent + hang : indent;
    if (line && (lead + line + ' ' + word).length > width) {
      lines.push(lead + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push((lines.length ? indent + hang : indent) + line);
  return lines.join('\n');
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// "3 weeks", "2 days", "5 hours", "a few minutes": how long, in words.
function span(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n >= 14 * DAY_MS) return plural(Math.round(n / (7 * DAY_MS)), 'week');
  if (n >= 2 * DAY_MS) return plural(Math.round(n / DAY_MS), 'day');
  if (n >= DAY_MS) return 'a day';
  if (n >= 2 * HOUR_MS) return plural(Math.round(n / HOUR_MS), 'hour');
  if (n >= HOUR_MS) return 'an hour';
  return 'a few minutes';
}

function sentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const upper = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(upper) ? upper : `${upper}.`;
}

// Task titles carry machine notes like "(Verify: grep ...)"; the reader
// needs the change, not the check command.
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*\((?:verify|check)\s*:[^)]*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Commit subjects: drop "fix:" style prefixes and "(#1234)" suffixes.
function cleanSubject(subject) {
  return String(subject || '')
    .replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/[.\s]+$/, '')
    .trim();
}

const HOUSEKEEPING_SUBJECT = /^(?:merge\b|refresh map|map refs?\b|update (?:the )?(?:journal|log|todo)|wip\b|revert "?merge)/i;

// Commits from the last day, newest first, from the same history read the
// quality check already does (no extra git call at start-up).
function recentChanges(commits, nowMs, windowMs = DAY_MS) {
  const list = (Array.isArray(commits) ? commits : [])
    .filter((c) => c && Number.isFinite(c.ms) && c.ms > nowMs - windowMs && c.ms <= nowMs + HOUR_MS)
    .filter((c) => !(Array.isArray(c.parents) && c.parents.length > 1))
    .sort((a, b) => b.ms - a.ms);
  const agents = list.filter((c) => c.isAgent).length;
  const examples = list
    .map((c) => cleanSubject(c.subject))
    .filter((s) => s && !HOUSEKEEPING_SUBJECT.test(s))
    .slice(0, 3);
  return { count: list.length, agents, examples };
}

function taskLine(item) {
  const title = cleanTitle(item.title);
  return title ? sentence(title) : '';
}

// One paragraph per thing a reader should know, in the order they should
// know it. Every input is optional; a missing one drops its paragraph.
function renderStatus(data = {}) {
  const now = Number.isFinite(data.now) ? data.now : Date.now();
  // Each paragraph is one idea with a blank line after it; list items
  // stay attached to the paragraph above them.
  const out = [];
  const para = (text) => { if (text) out.push(wrap(text), ''); };
  const item = (text) => {
    if (!text) return;
    if (out[out.length - 1] === '') out.pop();
    out.push(wrap(text, { indent: '    ' }).replace(/^ {4}/, '  - '), '');
  };
  const glance = data.glance || {};

  const certified = Array.isArray(glance.certifiedItems) ? glance.certifiedItems : [];
  if (glance.reviewCertified > 0) {
    para(`Waiting on you: ${plural(glance.reviewCertified, 'finished change')} passed a second agent's check and ${glance.reviewCertified === 1 ? 'needs' : 'need'} your ok before ${glance.reviewCertified === 1 ? 'it counts' : 'they count'} as done.`);
    // The owner has to recognise what they are approving, so the title leads.
    certified.forEach((t) => item(taskLine(t)));
  }

  const recent = data.recent;
  if (recent && Number.isFinite(recent.count)) {
    if (recent.count === 0) {
      para('Nothing new was added to this project in the last day.');
    } else {
      const byAgents = recent.agents > 0
        ? (recent.agents === recent.count ? ', all of them by agents' : `, ${recent.agents} of them by agents`)
        : '';
      para(`In the last day, ${plural(recent.count, 'change was', 'changes were')} added to this project${byAgents}.${recent.examples.length ? ` The newest ${recent.examples.length === 1 ? 'one' : recent.examples.length}:` : ''}`);
      recent.examples.forEach((s) => item(sentence(s)));
    }
  }

  const active = Array.isArray(glance.activeItems) ? glance.activeItems : [];
  for (const job of active) {
    const title = cleanTitle(job.title);
    if (!title) continue;
    const started = Number.isFinite(job.startedMs) ? job.startedMs : null;
    const moved = Number.isFinite(job.movedMs) ? job.movedMs : started;
    const why = job.result ? ` When it is done: ${sentence(job.result).replace(/^./, (c) => c.toLowerCase())}` : '';
    if (moved != null && now - moved > STUCK_AFTER_MS) {
      const startedText = started != null ? `${span(now - started)} ago` : 'a while ago';
      const still = started != null && moved - started < DAY_MS
        ? 'has not moved since'
        : `nothing has moved in ${span(now - moved)}`;
      para(`Stuck: an agent started "${title}" ${startedText} and ${still}, so it is not getting done.${why}`);
    } else {
      const startedText = started != null ? ` It started ${span(now - started)} ago.` : '';
      para(`Working now: an agent is on "${title}".${startedText}${why}`);
    }
  }
  const moreActive = (glance.active || 0) - active.length;
  if (moreActive > 0) para(`${plural(moreActive, 'more job is', 'more jobs are')} also in progress.`);
  if (!(glance.active > 0) && glance.backlog > 0 && Array.isArray(glance.backlogTitles) && glance.backlogTitles.length) {
    para(`Nothing is in progress. The next job on the list is "${cleanTitle(glance.backlogTitles[0])}".`);
  }

  const waitingCheck = (glance.review || 0) - (glance.reviewCertified || 0);
  const reviewItems = Array.isArray(glance.reviewItems) ? glance.reviewItems : [];
  if (waitingCheck > 0) {
    const oldest = reviewItems.map((r) => r.movedMs).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const waited = Number.isFinite(oldest) ? ` The oldest has waited ${span(now - oldest)}.` : '';
    para(`Waiting for a check: ${plural(waitingCheck, 'finished change is', 'finished changes are')} waiting for a second agent to review ${waitingCheck === 1 ? 'it' : 'them'} before ${waitingCheck === 1 ? 'it counts' : 'they count'}.${waited}`);
    reviewItems.forEach((r) => item(r.result ? sentence(r.result) : taskLine(r)));
  }

  if (glance.backlog > 0 && glance.active > 0) {
    para(`Not started: ${plural(glance.backlog, 'more job is', 'more jobs are')} written down and waiting for an agent.`);
  }

  const rev = data.revisions;
  if (rev && rev.fixed > 0 && rev.landings > 0) {
    const pct = Math.max(1, Math.round((rev.fixed / rev.landings) * 100));
    para(`Quality: in the last week, ${rev.fixed} of the ${rev.landings} changes agents added had their new lines rewritten within three days by a commit with no agent signature, which usually means a person fixed them. That is ${pct} percent, and the goal is zero.`);
  }

  const notes = [];
  if (data.openProblems > 0) notes.push(`Agents wrote down ${plural(data.openProblems, 'problem')} they have not solved yet.`);
  if (data.cleared > 0) notes.push(`The cleanup took ${plural(data.cleared, 'finished or idle job')} off the list.`);
  if (data.lately) notes.push(sentence(`Background cleanup: ${data.lately}`));
  if (data.tidyChores) notes.push(sentence(data.tidyChores));
  if (data.docs) notes.push(data.docs);
  if (data.wikiGrown) notes.push('The project notes have grown a lot since they were last tidied, so agents spend longer reading them.');
  if (data.brief) notes.push(`New notes: an agent studied "${data.brief.title}" and saved what it learned in ${data.brief.path}.`);
  if (data.diaryEntries > 0) notes.push(`Today's work diary has ${plural(data.diaryEntries, 'entry', 'entries')}.`);
  notes.forEach(para);

  if (data.goal) para(`The goal: ${data.goal}`);
  para(data.team);
  para(data.tools);
  para(data.values);

  while (out.length && out[out.length - 1] === '') out.pop();
  // Titles and notes written elsewhere can carry long dashes; the screen
  // reads as plain sentences, so they become commas.
  return out.join('\n').replace(/ *\u2014 */g, ', ');
}

function valuesSentence(values) {
  const list = (Array.isArray(values) ? values : []).filter((v) => v && v.name);
  if (!list.length) return '';
  const parts = list.map((v) => (v.gist ? `${v.name} (${v.gist})` : v.name));
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `When a call is close, agents decide by ${list.length === 1 ? 'one value' : `${list.length} values`}: ${joined}.`;
}

module.exports = {
  recentChanges,
  renderStatus,
  valuesSentence,
  wrap,
};
