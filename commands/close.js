const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_LANES = new Set(['business', 'life', 'code']);
const LEDGER_RELATIVE_PATH = path.join('.atris', 'state', 'closure.jsonl');
const TASK_PROJECTION_RELATIVE_PATH = path.join('.atris', 'state', 'tasks.projection.json');
const MISSIONS_RELATIVE_PATH = path.join('.atris', 'state', 'missions.jsonl');
const WATCH_CONFIG_RELATIVE_PATH = path.join('.atris', 'close-watch.json');
const RESOLVED_IN_SOURCE_PROOF = 'resolved in source store';

function ledgerPath(cwd = process.cwd()) {
  return path.join(cwd, LEDGER_RELATIVE_PATH);
}

function ensureLedgerDir(cwd = process.cwd()) {
  fs.mkdirSync(path.dirname(ledgerPath(cwd)), { recursive: true });
}

function normalizeSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function canonicalWhat(text) {
  return normalizeSpaces(text).toLowerCase();
}

function slugPart(text) {
  const slug = canonicalWhat(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'loop';
}

function closeIdForWhat(what) {
  const canonical = canonicalWhat(what);
  const hash = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 7);
  return `close-${slugPart(canonical)}-${hash}`;
}

function closeIdForSource(source) {
  const canonical = canonicalWhat(source);
  const hash = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 7);
  return `close-${slugPart(canonical)}-${hash}`;
}

function readEvents(cwd = process.cwd()) {
  const file = ledgerPath(cwd);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\n/).filter((line) => line.trim());
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid closure ledger json on line ${index + 1}`);
    }
  });
}

function appendEvent(event, cwd = process.cwd()) {
  ensureLedgerDir(cwd);
  fs.appendFileSync(ledgerPath(cwd), `${JSON.stringify(event)}\n`);
}

function isoDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric)) return numeric;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function eventTime(event) {
  return event.at || event.opened_at || null;
}

function foldEvents(events, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const flags = new Map();

  for (const event of events) {
    if (!event || !event.kind || !event.id) continue;

    if (event.kind === 'opened') {
      flags.set(event.id, {
        id: event.id,
        what: normalizeSpaces(event.what),
        owner: normalizeSpaces(event.owner || 'operator').toLowerCase(),
        lane: VALID_LANES.has(event.lane) ? event.lane : 'business',
        opened_at: event.opened_at || event.at,
        ttl_days: Number(event.ttl_days) || 7,
        close_condition: normalizeSpaces(event.close_condition || 'the loop is resolved'),
        source: normalizeSpaces(event.source || 'manual'),
        status: 'open',
        closed_at: null,
        dissolved_at: null,
        snoozed_until: null,
        escalated_days: [],
        events: [event],
      });
      continue;
    }

    const flag = flags.get(event.id);
    if (!flag) continue;
    flag.events.push(event);

    if (event.kind === 'closed') {
      flag.status = 'closed';
      flag.closed_at = eventTime(event);
      flag.proof = event.proof || '';
    } else if (event.kind === 'dissolved') {
      flag.status = 'dissolved';
      flag.dissolved_at = eventTime(event);
      flag.why = event.why || '';
    } else if (event.kind === 'snoozed') {
      flag.snoozed_until = event.until || null;
    } else if (event.kind === 'escalated') {
      const day = event.day || (event.at ? String(event.at).slice(0, 10) : null);
      if (day && !flag.escalated_days.includes(day)) flag.escalated_days.push(day);
    }
  }

  return Array.from(flags.values()).map((flag) => withComputedState(flag, now));
}

function withComputedState(flag, now = new Date()) {
  const openedMs = parseDate(flag.opened_at) || now.getTime();
  const ttlDueMs = openedMs + (Number(flag.ttl_days) || 7) * DAY_MS;
  const snoozedMs = flag.snoozed_until ? parseDate(flag.snoozed_until) : null;
  const dueMs = Math.max(ttlDueMs, snoozedMs || 0);
  const nowMs = now.getTime();
  const isOpen = flag.status === 'open';
  const overdue = isOpen && nowMs >= dueMs;
  const daysOld = Math.max(0, Math.floor((nowMs - openedMs) / DAY_MS));
  const daysPastTtl = overdue ? Math.max(0, Math.floor((nowMs - dueMs) / DAY_MS)) : 0;

  return {
    ...flag,
    due_at: new Date(dueMs).toISOString(),
    days_old: daysOld,
    days_past_ttl: daysPastTtl,
    overdue,
  };
}

function openFlags(cwd = process.cwd(), options = {}) {
  return foldEvents(readEvents(cwd), options).filter((flag) => flag.status === 'open');
}

function ownerWaitRank(flag) {
  return /^(you|me|operator|human|keshav)$/.test(String(flag.owner || '').toLowerCase()) ? 0 : 1;
}

function compareOpenFlags(a, b) {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  if (a.overdue && b.overdue && b.days_past_ttl !== a.days_past_ttl) {
    return b.days_past_ttl - a.days_past_ttl;
  }
  const aDue = parseDate(a.due_at) || 0;
  const bDue = parseDate(b.due_at) || 0;
  if (aDue !== bDue) return aDue - bDue;
  return a.what.localeCompare(b.what);
}

function compareSweepFlags(a, b) {
  const ownerRank = ownerWaitRank(a) - ownerWaitRank(b);
  if (ownerRank !== 0) return ownerRank;
  return compareOpenFlags(a, b);
}

function formatDays(count) {
  return `${count} ${count === 1 ? 'day' : 'days'}`;
}

function trimSentenceEnd(text) {
  return String(text || '').replace(/[.?!]+$/g, '');
}

function listLine(flag) {
  const parts = [
    flag.what.toLowerCase(),
    `${formatDays(flag.days_old)} old`,
  ];
  if (flag.overdue) {
    parts.push(`${formatDays(flag.days_past_ttl)} past ttl`);
  }
  return parts.join(', ');
}

function sweepLine(flag) {
  const what = trimSentenceEnd(flag.what.toLowerCase());
  const closeCondition = trimSentenceEnd(flag.close_condition.toLowerCase());
  const late = `${formatDays(flag.days_past_ttl)} late`;
  if (ownerWaitRank(flag) === 0) {
    return `${what} is waiting on you, ${late}, close it when ${closeCondition}.`;
  }
  return `${flag.owner} owns ${what}, ${late}, close it when ${closeCondition}.`;
}

function parseArgs(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    if (key === 'json' || key === 'help') {
      options[key] = true;
      continue;
    }

    if (equalsIndex >= 0) {
      options[key] = arg.slice(equalsIndex + 1);
      continue;
    }

    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { positional, options };
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return number;
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function publicFlag(flag) {
  const { events, ...rest } = flag;
  return rest;
}

function printHelp() {
  console.log('usage: atris close <add|list|done|dissolve|snooze|sweep|scan>');
  console.log('add "<what>" [--owner x] [--lane life|business|code] [--ttl 7] [--when "<condition>"] [--source y]');
  console.log('list [--json] [--lane x]');
  console.log('done <id> [--proof "..."]');
  console.log('dissolve <id> --why "..."');
  console.log('snooze <id> --days n');
  console.log('sweep [--json]');
  console.log('scan [--json]');
}

function commandAdd(args, context = {}) {
  const { positional, options } = parseArgs(args);
  const what = normalizeSpaces(positional.join(' '));
  if (!what) throw new Error('what is required');

  const lane = String(options.lane || 'business').toLowerCase();
  if (!VALID_LANES.has(lane)) throw new Error('lane must be business, life, or code');

  const ttlDays = options.ttl === undefined ? 7 : positiveNumber(options.ttl, 'ttl');
  const now = context.now ? new Date(context.now) : new Date();
  const existing = openFlags(context.cwd, { now }).find((flag) => canonicalWhat(flag.what) === canonicalWhat(what));
  if (existing) {
    console.log(`already open: ${existing.id}`);
    return 0;
  }

  const openedAt = now.toISOString();
  const event = {
    kind: 'opened',
    at: openedAt,
    id: closeIdForWhat(what),
    what,
    owner: normalizeSpaces(options.owner || 'operator').toLowerCase(),
    lane,
    opened_at: openedAt,
    ttl_days: ttlDays,
    close_condition: normalizeSpaces(options.when || 'the loop is resolved'),
    source: normalizeSpaces(options.source || 'manual'),
  };
  appendEvent(event, context.cwd);
  console.log(`opened ${event.id}`);
  return 0;
}

function commandList(args, context = {}) {
  const { options } = parseArgs(args);
  const lane = options.lane ? String(options.lane).toLowerCase() : null;
  if (lane && !VALID_LANES.has(lane)) throw new Error('lane must be business, life, or code');

  let flags = openFlags(context.cwd, { now: context.now });
  if (lane) flags = flags.filter((flag) => flag.lane === lane);
  flags.sort(compareOpenFlags);

  if (options.json) {
    printJson({ open: flags.map(publicFlag) });
    return 0;
  }

  if (flags.length === 0) {
    console.log('nothing open.');
    return 0;
  }

  flags.forEach((flag) => console.log(listLine(flag)));
  return 0;
}

function requireOpenFlag(id, context = {}) {
  const flag = openFlags(context.cwd, { now: context.now }).find((item) => item.id === id);
  if (!flag) throw new Error(`${id} is not open`);
  return flag;
}

function commandDone(args, context = {}) {
  const { positional, options } = parseArgs(args);
  const id = positional[0];
  if (!id) throw new Error('id is required');
  requireOpenFlag(id, context);
  const at = (context.now ? new Date(context.now) : new Date()).toISOString();
  appendEvent({
    kind: 'closed',
    at,
    id,
    proof: normalizeSpaces(options.proof || ''),
  }, context.cwd);
  console.log(`closed ${id}`);
  return 0;
}

function commandDissolve(args, context = {}) {
  const { positional, options } = parseArgs(args);
  const id = positional[0];
  if (!id) throw new Error('id is required');
  const why = normalizeSpaces(options.why || '');
  if (!why) throw new Error('why is required');
  requireOpenFlag(id, context);
  const at = (context.now ? new Date(context.now) : new Date()).toISOString();
  appendEvent({
    kind: 'dissolved',
    at,
    id,
    why,
  }, context.cwd);
  console.log(`dissolved ${id}`);
  return 0;
}

function commandSnooze(args, context = {}) {
  const { positional, options } = parseArgs(args);
  const id = positional[0];
  if (!id) throw new Error('id is required');
  const days = positiveNumber(options.days, 'days');
  requireOpenFlag(id, context);
  const now = context.now ? new Date(context.now) : new Date();
  const until = new Date(now.getTime() + days * DAY_MS).toISOString();
  appendEvent({
    kind: 'snoozed',
    at: now.toISOString(),
    id,
    days,
    until,
  }, context.cwd);
  console.log(`snoozed ${id} for ${formatDays(days)}`);
  return 0;
}

// Escalation core shared by the CLI verb and the hourly pulse tick: append
// one escalated event per overdue flag per day, return the resulting state.
function sweepState(cwd = process.cwd(), now = new Date()) {
  const today = isoDateOnly(now);
  let flags = openFlags(cwd, { now });
  const overdue = flags.filter((flag) => flag.overdue).sort(compareSweepFlags);
  const escalatedToday = [];

  for (const flag of overdue) {
    if (flag.escalated_days.includes(today)) continue;
    appendEvent({
      kind: 'escalated',
      at: now.toISOString(),
      id: flag.id,
      day: today,
    }, cwd);
    escalatedToday.push(flag.id);
  }

  flags = openFlags(cwd, { now });
  return { open: flags.length, overdue, escalated_today: escalatedToday };
}

function commandSweep(args, context = {}) {
  const { options } = parseArgs(args);
  const now = context.now ? new Date(context.now) : new Date();
  const { open, overdue, escalated_today: escalatedToday } = sweepState(context.cwd, now);

  if (options.json) {
    printJson({
      open,
      overdue: overdue.length,
      escalated_today: escalatedToday,
    });
    return 0;
  }

  if (overdue.length === 0) {
    console.log('nothing is overdue.');
    return 0;
  }

  overdue.forEach((flag) => console.log(sweepLine(flag)));
  return 0;
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonlFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split(/\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readTaskProjection(cwd) {
  const payload = readJsonFile(path.join(cwd, TASK_PROJECTION_RELATIVE_PATH));
  return payload && Array.isArray(payload.tasks) ? payload.tasks : [];
}

function readMissions(cwd) {
  return readJsonlFile(path.join(cwd, MISSIONS_RELATIVE_PATH));
}

function latestById(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const id = normalizeSpaces(row && row.id);
    if (!id) continue;
    map.set(id, row);
  }
  return map;
}

function isOlderThan(value, days, now) {
  const ms = parseDate(value);
  return ms !== null && now.getTime() - ms > days * DAY_MS;
}

function taskRef(task) {
  return normalizeSpaces(task && (task.display_id || task.id));
}

function taskSource(task) {
  const id = normalizeSpaces(task && task.id);
  return id ? `task:${id}` : '';
}

function taskResolved(task) {
  const status = normalizeSpaces(task && task.status).toLowerCase();
  return status === 'done' || status === 'accepted';
}

function reviewObject(task) {
  const review = task && task.review;
  return review && typeof review === 'object' && !Array.isArray(review) ? review : {};
}

function taskWaitingOnHumanAccept(task) {
  if (!task || taskResolved(task)) return false;
  const status = normalizeSpaces(task.status).toLowerCase();
  const review = task.review;
  if (!review) return false;

  const reviewData = reviewObject(task);
  const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const approval = normalizeSpaces(reviewData.approval_status || metadata.approval_status).toLowerCase();
  if (['accepted', 'approved', 'done', 'closed'].includes(approval)) return false;
  if (status === 'review') return true;
  if (['pending', 'waiting', 'needs_accept', 'needs_acceptance', 'needs-human', 'needs_human'].includes(approval)) return true;
  if (reviewData.agent_certified === true || metadata.agent_certified === true) return true;

  const text = normalizeSpaces([
    typeof review === 'string' ? review : '',
    reviewData.status,
    reviewData.waiting_on,
    reviewData.next_action,
    reviewData.summary,
  ].join(' ')).toLowerCase();
  return /\bhuman\b/.test(text) && /\baccept|approval\b/.test(text);
}

function failedTaskNeedsAttention(task, now) {
  return normalizeSpaces(task && task.status).toLowerCase() === 'failed'
    && isOlderThan(task.updated_at, 2, now);
}

function resolveWatchPath(cwd, watchPath) {
  return path.isAbsolute(watchPath) ? watchPath : path.join(cwd, watchPath);
}

function readWatchConfig(cwd) {
  const payload = readJsonFile(path.join(cwd, WATCH_CONFIG_RELATIVE_PATH));
  if (!Array.isArray(payload)) return [];
  return payload.map((entry) => {
    const watchPath = normalizeSpaces(entry && entry.path);
    const what = normalizeSpaces(entry && entry.what);
    const pattern = entry && entry.pattern !== undefined ? String(entry.pattern) : '';
    if (!watchPath || !what || !pattern) return null;
    let regex;
    try {
      regex = new RegExp(pattern);
    } catch {
      return null;
    }
    const lane = normalizeSpaces(entry.lane || 'code').toLowerCase();
    const ttlDays = Number(entry.ttl_days) > 0 ? Number(entry.ttl_days) : 3;
    return {
      path: watchPath,
      file_path: resolveWatchPath(cwd, watchPath),
      source: `watch:${watchPath}`,
      regex,
      lane: VALID_LANES.has(lane) ? lane : 'code',
      ttl_days: ttlDays,
      what,
    };
  }).filter(Boolean);
}

function watchMatch(entry) {
  try {
    if (!fs.existsSync(entry.file_path)) return { readable: false, matches: false };
    const content = fs.readFileSync(entry.file_path, 'utf8');
    entry.regex.lastIndex = 0;
    return { readable: true, matches: entry.regex.test(content) };
  } catch {
    return { readable: false, matches: false };
  }
}

function shortText(text, maxLength = 70) {
  const value = normalizeSpaces(text);
  if (value.length <= maxLength) return value;
  const clipped = value.slice(0, maxLength).replace(/\s+\S*$/g, '').trim();
  return clipped || value.slice(0, maxLength).trim();
}

function appendOpenedFromSource({ what, lane = 'code', ttlDays = 3, source }, cwd, now) {
  const event = {
    kind: 'opened',
    at: now.toISOString(),
    id: closeIdForSource(source),
    what,
    owner: 'operator',
    lane: VALID_LANES.has(lane) ? lane : 'code',
    opened_at: now.toISOString(),
    ttl_days: Number(ttlDays) || 3,
    close_condition: 'the source store resolves it',
    source,
  };
  appendEvent(event, cwd);
  return event;
}

function appendClosedFromSource(flag, cwd, now) {
  const event = {
    kind: 'closed',
    at: now.toISOString(),
    id: flag.id,
    proof: RESOLVED_IN_SOURCE_PROOF,
  };
  appendEvent(event, cwd);
  return event;
}

function scanState(cwd = process.cwd(), options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const tasks = readTaskProjection(cwd);
  const tasksById = latestById(tasks);
  const missions = Array.from(latestById(readMissions(cwd)).values());
  const missionsById = latestById(missions);
  const watchEntries = readWatchConfig(cwd);
  const watchBySource = new Map(watchEntries.map((entry) => [entry.source, entry]));
  const openBySource = new Map();
  const autoClosed = [];

  for (const flag of openFlags(cwd, { now })) {
    if (flag.source) openBySource.set(flag.source, flag);
  }

  const closeFlag = (flag) => {
    const event = appendClosedFromSource(flag, cwd, now);
    autoClosed.push({ flag, event });
    openBySource.delete(flag.source);
  };

  for (const flag of Array.from(openBySource.values())) {
    if (flag.source.startsWith('task:')) {
      const task = tasksById.get(flag.source.slice('task:'.length));
      if (task && taskResolved(task)) closeFlag(flag);
      continue;
    }
    if (flag.source.startsWith('mission:')) {
      const mission = missionsById.get(flag.source.slice('mission:'.length));
      const status = normalizeSpaces(mission && mission.status).toLowerCase();
      if (status === 'complete' || status === 'completed' || status === 'stopped') closeFlag(flag);
      continue;
    }
    if (flag.source.startsWith('watch:')) {
      const entry = watchBySource.get(flag.source);
      if (!entry) continue;
      const matched = watchMatch(entry);
      if (matched.readable && !matched.matches) closeFlag(flag);
    }
  }

  const opened = [];
  const openCandidate = (candidate) => {
    if (!candidate.source || openBySource.has(candidate.source)) return null;
    const event = appendOpenedFromSource(candidate, cwd, now);
    opened.push(event);
    openBySource.set(candidate.source, { ...event, status: 'open' });
    return event;
  };

  for (const task of tasks) {
    const source = taskSource(task);
    const ref = taskRef(task);
    if (!source || !ref) continue;
    if (taskWaitingOnHumanAccept(task) && isOlderThan(task.updated_at, 5, now)) {
      openCandidate({
        what: `task ${ref} has waited in review too long, accept it or send it back`,
        lane: 'code',
        ttlDays: 3,
        source,
      });
      continue;
    }
    if (failedTaskNeedsAttention(task, now)) {
      openCandidate({
        what: `task ${ref} failed and nobody looked, retry it or dissolve it`,
        lane: 'code',
        ttlDays: 3,
        source,
      });
    }
  }

  const staleMissions = missions
    .filter((mission) => ['running', 'planning'].includes(normalizeSpaces(mission.status).toLowerCase()))
    .filter((mission) => isOlderThan(mission.updated_at, 5, now))
    .sort((a, b) => (parseDate(a.updated_at) || 0) - (parseDate(b.updated_at) || 0));
  const missionCap = 10;
  const missionSkipped = Math.max(0, staleMissions.length - missionCap);
  for (const mission of staleMissions.slice(0, missionCap)) {
    const id = normalizeSpaces(mission.id);
    if (!id) continue;
    openCandidate({
      what: `mission ${shortText(mission.objective || id)} has not moved in days, resume it or stop it`,
      lane: 'code',
      ttlDays: 3,
      source: `mission:${id}`,
    });
  }

  for (const entry of watchEntries) {
    const matched = watchMatch(entry);
    if (!matched.readable || !matched.matches) continue;
    openCandidate({
      what: entry.what,
      lane: entry.lane,
      ttlDays: entry.ttl_days,
      source: entry.source,
    });
  }

  return {
    opened,
    auto_closed: autoClosed,
    skipped: {
      missions: missionSkipped,
    },
  };
}

function publicScanOpened(event) {
  return {
    id: event.id,
    what: event.what,
    source: event.source,
    lane: event.lane,
    ttl_days: event.ttl_days,
  };
}

function publicScanClosed(item) {
  return {
    id: item.event.id,
    what: item.flag.what,
    source: item.flag.source,
    proof: item.event.proof,
  };
}

function commandScan(args, context = {}) {
  const { options } = parseArgs(args);
  const result = scanState(context.cwd, { now: context.now });

  if (options.json) {
    printJson({
      opened: result.opened.map(publicScanOpened),
      auto_closed: result.auto_closed.map(publicScanClosed),
      skipped: result.skipped,
      counts: {
        opened: result.opened.length,
        auto_closed: result.auto_closed.length,
      },
    });
    return 0;
  }

  const lines = [];
  for (const event of result.opened) {
    lines.push(`opened ${trimSentenceEnd(event.what).toLowerCase()}.`);
  }
  for (const item of result.auto_closed) {
    lines.push(`auto-closed ${trimSentenceEnd(item.flag.what).toLowerCase()}.`);
  }
  if (result.skipped.missions > 0) {
    lines.push(`skipped ${result.skipped.missions} stale missions due to cap.`);
  }
  if (lines.length === 0) {
    console.log('nothing new to open, nothing resolved.');
    return 0;
  }
  lines.forEach((line) => console.log(line));
  return 0;
}

function run(args = [], context = {}) {
  const subcommand = args[0];
  const rest = args.slice(1);
  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      printHelp();
      return 0;
    }
    if (subcommand === 'add') return commandAdd(rest, context);
    if (subcommand === 'list') return commandList(rest, context);
    if (subcommand === 'done') return commandDone(rest, context);
    if (subcommand === 'dissolve') return commandDissolve(rest, context);
    if (subcommand === 'snooze') return commandSnooze(rest, context);
    if (subcommand === 'sweep') return commandSweep(rest, context);
    if (subcommand === 'scan') return commandScan(rest, context);
    console.error(`unknown close command: ${subcommand}`);
    return 2;
  } catch (error) {
    console.error(`error: ${error.message || error}`);
    return 2;
  }
}

module.exports = {
  run,
  sweepState,
  scanState,
  closeIdForWhat,
  foldEvents,
  openFlags,
  ledgerPath,
  readEvents,
  listLine,
  sweepLine,
};
