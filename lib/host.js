'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG = Object.freeze({ cadence_days: 3, question_expiry_days: 7, pause_after_unanswered: 2, intro_expiry_days: 7, intros_per_person_per_30d: 1 });
const PERSON_KEYS = ['schema', 'id', 'name', 'team', 'manager_id', 'door', 'status', 'joined_at', 'told_host_sees_at', 'next_question_at', 'pending_question_id', 'pending_question', 'pending_expires_at', 'unanswered_count', 'revision', 'processed_events'];
const INTRO_KEYS = ['a', 'b', 'attempt_id', 'reason', 'activity', 'version', 'a_said', 'b_said', 'state', 'created_at', 'expires_at', 'closed_reason'];
const CARD_KEYS = ['into_lately', 'going_for', 'great_at', 'wants_to_meet', 'worth_celebrating'];
const CARD_TITLES = ['Into lately', 'Going for', 'Great at', 'Wants to meet', 'Worth celebrating'];

function fail(message) { throw new Error(message); }
function required(value, label) { if (typeof value !== 'string' || !value.trim()) fail(`${label} is required`); return value.trim(); }
function singleLine(value, label) { const text = required(value, label); if (/[\r\n]/.test(text)) fail(`${label} must be one line`); return text; }
function safeId(value) { const id = required(value, 'id'); if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id)) fail('id must use letters, numbers, colon, underscore, or dash'); return id; }
function fileId(id) { return encodeURIComponent(safeId(id)); }
function days(iso, count) { return new Date(Date.parse(iso) + count * 86400000).toISOString(); }
function nowIso(now) { const date = new Date(now || Date.now()); if (!Number.isFinite(date.getTime())) fail('invalid time'); return date.toISOString(); }
function privateDir(root) { if (!fs.existsSync(path.join(root, 'atris'))) fail('run from a workspace containing atris/'); return path.join(root, 'atris', 'team', 'host', 'private'); }
function personPath(root, id) { return path.join(privateDir(root), 'people', `${fileId(id)}.md`); }
function cardPath(root, id) { return path.join(root, 'atris', 'wiki', 'people', `${fileId(id)}.md`); }
function introDir(root) { return path.join(privateDir(root), 'intros'); }
function outboxDir(root) { return path.join(privateDir(root), 'outbox'); }
function readText(file, fallback = null) { if (!fs.existsSync(file)) return fallback; return fs.readFileSync(file, 'utf8'); }
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, content, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function json(file, fallback = null) {
  const raw = readText(file);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch { fail(`malformed json: ${file}`); }
}
function putJson(file, value) { atomic(file, `${JSON.stringify(value, null, 2)}\n`); }
function rows(file) {
  const raw = readText(file, '');
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { fail(`malformed jsonl: ${file}`); }
  });
}
function putRows(file, entries) { atomic(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '')); }
function record(file, keys) {
  const raw = readText(file);
  if (raw === null) fail(`missing record: ${file}`);
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) fail(`malformed record: ${file}`);
  const data = {};
  for (const line of match[1].split('\n')) {
    const part = line.match(/^([a-z_]+): (.+)$/);
    if (!part || !keys.includes(part[1]) || Object.hasOwn(data, part[1])) fail(`malformed record: ${file}`);
    try { data[part[1]] = JSON.parse(part[2]); } catch { fail(`malformed record: ${file}`); }
  }
  if (keys.some((key) => !Object.hasOwn(data, key))) fail(`malformed record: ${file}`);
  return { data, body: match[2] };
}
function putRecord(file, keys, data, body = '') {
  atomic(file, `---\n${keys.map((key) => `${key}: ${JSON.stringify(data[key])}`).join('\n')}\n---\n${body}`);
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function locked(root, work) {
  const dir = privateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + 10000;
  while (true) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 600000) fs.rmSync(lock, { recursive: true, force: true }); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      if (Date.now() >= deadline) fail('host is busy; retry');
      sleep(20 + Math.floor(Math.random() * 50));
    }
  }
  try { return work(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
function config(root) {
  const file = path.join(privateDir(root), 'config.json');
  if (!fs.existsSync(file)) putJson(file, DEFAULT_CONFIG);
  const value = json(file);
  if (!value || Object.keys(DEFAULT_CONFIG).some((key) => !Number.isInteger(value[key]) || value[key] < 1)) fail(`malformed config: ${file}`);
  return value;
}
function people(root) {
  const dir = path.join(privateDir(root), 'people');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => record(path.join(dir, name), PERSON_KEYS)).sort((a, b) => a.data.name.localeCompare(b.data.name));
}
function person(root, id) { return record(personPath(root, id), PERSON_KEYS); }
function savePerson(root, entry) { entry.data.revision += 1; putRecord(personPath(root, entry.data.id), PERSON_KEYS, entry.data, entry.body); }
function intros(root) {
  const dir = introDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => ({ file: path.join(dir, name), ...record(path.join(dir, name), INTRO_KEYS) }));
}
function queue(root, to, kind, text, at, attemptId = null) {
  const recipient = person(root, to).data;
  const message = { id: crypto.randomUUID(), to, door: recipient.door, kind, text, created_at: at, state: 'queued' };
  if (attemptId) message.attempt_id = attemptId;
  putJson(path.join(outboxDir(root), `${message.id}.json`), message);
  return message;
}
function messages(root) {
  const dir = outboxDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => json(path.join(dir, name))).sort((a, b) => a.created_at.localeCompare(b.created_at));
}
function dropQueued(root, predicate) {
  for (const message of messages(root)) if (message.state === 'queued' && predicate(message)) fs.unlinkSync(path.join(outboxDir(root), `${message.id}.json`));
}
function closeIntro(root, entry, reason) {
  entry.data.state = 'closed';
  entry.data.closed_reason = reason;
  putRecord(entry.file, INTRO_KEYS, entry.data, entry.body);
  dropQueued(root, (message) => message.kind === 'intro_ask' && message.attempt_id === entry.data.attempt_id);
}
function closeFor(root, id, reason) {
  for (const entry of intros(root)) if (entry.data.state === 'pending' && [entry.data.a, entry.data.b].includes(id)) closeIntro(root, entry, reason);
}
function expireIntros(root, at) {
  for (const entry of intros(root)) if (entry.data.state === 'pending' && entry.data.expires_at <= at) closeIntro(root, entry, 'expired');
}
function expireQuestions(root, at, settings) {
  for (const entry of people(root)) {
    const p = entry.data;
    if (p.status !== 'active' || !p.pending_question_id || p.pending_expires_at > at) continue;
    p.pending_question_id = null; p.pending_question = null; p.pending_expires_at = null;
    p.unanswered_count += 1;
    dropQueued(root, (message) => message.to === p.id && message.kind === 'question');
    if (p.unanswered_count >= settings.pause_after_unanswered) {
      p.status = 'paused';
      closeFor(root, p.id, 'pause');
      dropQueued(root, (message) => message.to === p.id);
    }
    savePerson(root, entry);
  }
}
function cardText(name, team, values) {
  return `---\nname: ${JSON.stringify(name)}\nteam: ${JSON.stringify(team)}\n---\n\n# ${name}\n\n${CARD_KEYS.map((key, index) => `## ${CARD_TITLES[index]}\n\n${values[key] || ''}`).join('\n\n')}\n`;
}
function cardValues(raw) {
  const values = {};
  for (let i = 0; i < CARD_KEYS.length; i += 1) {
    const start = raw.indexOf(`## ${CARD_TITLES[i]}\n\n`);
    if (start < 0) fail('malformed published card');
    const begin = start + `## ${CARD_TITLES[i]}\n\n`.length;
    const end = raw.indexOf('\n\n## ', begin);
    values[CARD_KEYS[i]] = raw.slice(begin, end < 0 ? undefined : end).trim();
  }
  return values;
}
function published(root, id) { const raw = readText(cardPath(root, id)); if (raw === null) fail(`missing published card for ${id}`); return raw; }
function pair(a, b) { return [safeId(a), safeId(b)].sort(); }

function hostAction(root, command, arg = {}) {
  if (command === 'view') {
    if (arg.as && arg.team) fail('choose --as or --team');
    if (arg.as) {
      const own = person(root, arg.as);
      return { cards: people(root).filter((entry) => entry.data.status !== 'left').map((entry) => ({ id: entry.data.id, card: published(root, entry.data.id) })), own: { ...own.data, body: own.body } };
    }
    if (arg.team) return { cards: people(root).filter((entry) => entry.data.status !== 'left' && entry.data.team === arg.team).map((entry) => ({ id: entry.data.id, card: published(root, entry.data.id) })) };
    fail('view needs --as <id> or --team <team>');
  }
  return locked(root, () => {
    const settings = config(root);
    const at = nowIso(arg.now);
    expireIntros(root, at);
    expireQuestions(root, at, settings);
    if (command === 'outbox') return messages(root).filter((message) => message.state === 'queued');
    if (command === 'join') {
      const id = safeId(arg.id);
      if (rows(path.join(privateDir(root), 'forgotten.jsonl')).some((row) => row.id === id)) fail('this id was forgotten and cannot rejoin');
      if (fs.existsSync(personPath(root, id))) fail('person already joined');
      const name = singleLine(arg.name, 'name');
      const data = { schema: 1, id, name, team: arg.team ? singleLine(arg.team, 'team') : '', manager_id: arg.manager || null, door: arg.door ? singleLine(arg.door, 'door') : id, status: 'active', joined_at: at, told_host_sees_at: at, next_question_at: at, pending_question_id: null, pending_question: null, pending_expires_at: null, unanswered_count: 0, revision: 1, processed_events: [] };
      if (data.manager_id) safeId(data.manager_id);
      putRecord(personPath(root, id), PERSON_KEYS, data, '');
      if (!fs.existsSync(cardPath(root, id))) atomic(cardPath(root, id), cardText(name, data.team, {}));
      queue(root, id, 'welcome', `Hi ${name}. I am the Host. I will ask a fun question now and then to get to know you. The human host can see your answers. You can pause or leave anytime.`, at);
      return { id, revision: 1, due: true };
    }
    if (['leave', 'pause', 'resume'].includes(command)) {
      const entry = person(root, arg.id);
      entry.data.status = command === 'resume' ? 'active' : command === 'leave' ? 'left' : 'paused';
      if (command !== 'resume') { closeFor(root, arg.id, command); dropQueued(root, (message) => message.to === arg.id); }
      if (command === 'resume') { entry.data.next_question_at = at; entry.data.unanswered_count = 0; }
      savePerson(root, entry);
      return { id: arg.id, status: entry.data.status };
    }
    if (command === 'forget') {
      const id = safeId(arg.id);
      person(root, id);
      for (const entry of people(root)) if (entry.data.id !== id && entry.data.manager_id === id) { entry.data.manager_id = null; savePerson(root, entry); }
      const affected = intros(root).filter((entry) => [entry.data.a, entry.data.b].includes(id));
      for (const entry of affected) fs.unlinkSync(entry.file);
      const attempts = new Set(affected.map((entry) => entry.data.attempt_id));
      for (const message of messages(root)) if (message.to === id || attempts.has(message.attempt_id)) fs.unlinkSync(path.join(outboxDir(root), `${message.id}.json`));
      const linkFile = path.join(privateDir(root), 'links.jsonl');
      putRows(linkFile, rows(linkFile).filter((link) => link.a !== id && link.b !== id));
      fs.unlinkSync(personPath(root, id));
      if (fs.existsSync(cardPath(root, id))) fs.unlinkSync(cardPath(root, id));
      const marker = path.join(privateDir(root), 'forgotten.jsonl');
      putRows(marker, [...rows(marker), { id }]);
      // The prior room summary may name this person.
      const room = path.join(privateDir(root), 'room.md');
      if (fs.existsSync(room)) fs.unlinkSync(room);
      return { id, forgotten: true };
    }
    if (command === 'due') {
      return people(root).filter((entry) => entry.data.status === 'active' && !entry.data.pending_question_id && entry.data.next_question_at <= at).map((entry) => ({ id: entry.data.id, name: entry.data.name, revision: entry.data.revision, card: published(root, entry.data.id) }));
    }
    if (command === 'ask') {
      const entry = person(root, arg.id);
      if (entry.data.status !== 'active' || entry.data.pending_question_id) fail('person is not ready for a question');
      if (entry.data.next_question_at > at) fail('question is not due yet');
      const question = required(arg.question, 'question');
      entry.data.pending_question_id = crypto.randomUUID();
      entry.data.pending_question = question;
      entry.data.pending_expires_at = days(at, settings.question_expiry_days);
      entry.data.next_question_at = days(at, settings.cadence_days);
      savePerson(root, entry);
      const message = queue(root, arg.id, 'question', question, at);
      return { id: arg.id, question_id: entry.data.pending_question_id, message_id: message.id, revision: entry.data.revision };
    }
    if (command === 'receive') {
      const eventId = required(arg.eventId, 'event id');
      const sender = required(arg.from, 'from');
      const matches = people(root).filter((entry) => entry.data.id === sender || entry.data.door === sender);
      if (matches.length !== 1) fail('unknown or ambiguous sender');
      const entry = matches[0];
      if (entry.data.processed_events.includes(eventId)) return { id: entry.data.id, duplicate: true };
      if (entry.data.status !== 'active') fail('person is not active');
      const answer = required(arg.text, 'text');
      entry.data.processed_events = [...entry.data.processed_events, eventId].slice(-200);
      const open = intros(root).find((intro) => intro.data.state === 'pending' && [intro.data.a, intro.data.b].includes(entry.data.id) && intro.data[intro.data.a === entry.data.id ? 'a_said' : 'b_said'] === null);
      const normalized = answer.toLowerCase().trim();
      const yes = ['yes', 'y', 'yeah', 'sure'].includes(normalized);
      const no = ['no', 'n', 'nah', 'pass'].includes(normalized);
      let kind = 'note';
      if (open && (yes || no)) {
        open.data[open.data.a === entry.data.id ? 'a_said' : 'b_said'] = yes ? 'yes' : 'no';
        if (no) { closeIntro(root, open, 'declined'); kind = 'intro_closed'; }
        else if (open.data.a_said === 'yes' && open.data.b_said === 'yes') {
          open.data.state = 'ready'; putRecord(open.file, INTRO_KEYS, open.data, open.body);
          queue(root, open.data.a, 'intro', open.body, at, open.data.attempt_id);
          queue(root, open.data.b, 'intro', open.body, at, open.data.attempt_id);
          open.data.state = 'introduced'; putRecord(open.file, INTRO_KEYS, open.data, open.body);
          const linkFile = path.join(privateDir(root), 'links.jsonl');
          putRows(linkFile, [...rows(linkFile), { a: open.data.a, b: open.data.b, source: 'intro', evidence: 'introduced by the Host', at }]);
          kind = 'introduced';
        } else { putRecord(open.file, INTRO_KEYS, open.data, open.body); kind = 'intro_yes'; }
      } else if (entry.data.pending_question_id && !yes && !no) {
        entry.body += `## ${at}\n\nQ: ${entry.data.pending_question}\n\nA: ${answer}\n\n`;
        entry.data.pending_question_id = null; entry.data.pending_question = null; entry.data.pending_expires_at = null; entry.data.unanswered_count = 0;
        kind = 'answer';
      } else {
        entry.body += `## ${at}\n\nNote: ${answer}\n\n`;
        if (open) { queue(root, entry.data.id, 'clarify', 'Would you like this introduction? Please reply yes or no.', at); kind = 'clarify'; }
      }
      savePerson(root, entry);
      return { id: entry.data.id, kind, revision: entry.data.revision };
    }
    if (command === 'card') {
      const entry = person(root, arg.id);
      if (Number(arg.expectedRevision) !== entry.data.revision) fail('stale card revision');
      const patch = json(path.resolve(root, required(arg.patch, 'patch file')));
      if (!patch || Array.isArray(patch) || typeof patch !== 'object' || Object.keys(patch).some((key) => !CARD_KEYS.includes(key) || typeof patch[key] !== 'string' || /^#{1,6}\s/m.test(patch[key]))) fail('card patch may contain only the five text fields without headings');
      const current = cardValues(published(root, arg.id));
      atomic(cardPath(root, arg.id), cardText(entry.data.name, entry.data.team, { ...current, ...patch }));
      savePerson(root, entry);
      return { id: arg.id, revision: entry.data.revision };
    }
    if (command === 'link') {
      const [a, b] = pair(arg.a, arg.b);
      if (a === b) fail('a person cannot link to themselves');
      person(root, a); person(root, b);
      if (!['channel', 'answer', 'card', 'intro'].includes(arg.source)) fail('invalid link source');
      const evidence = required(arg.evidence, 'evidence');
      const file = path.join(privateDir(root), 'links.jsonl');
      const links = rows(file);
      if (!links.some((link) => link.a === a && link.b === b && link.source === arg.source && link.evidence === evidence)) links.push({ a, b, source: arg.source, evidence, at });
      putRows(file, links);
      return { a, b, linked: true };
    }
    if (command === 'propose') {
      const [a, b] = pair(arg.a, arg.b);
      if (a === b) fail('cannot introduce a person to themselves');
      const one = person(root, a).data, two = person(root, b).data;
      if (one.status !== 'active' || two.status !== 'active') fail('both people must be active');
      if (one.manager_id === b || two.manager_id === a) fail('manager and report cannot be introduced');
      if (rows(path.join(privateDir(root), 'links.jsonl')).some((link) => link.a === a && link.b === b && link.source !== 'card')) fail('people are already linked');
      const history = intros(root);
      if (history.some((entry) => entry.data.a === a && entry.data.b === b && entry.data.closed_reason === 'declined')) fail('this pair declined before');
      if (history.some((entry) => entry.data.a === a && entry.data.b === b && ['pending', 'ready'].includes(entry.data.state))) fail('this pair already has an introduction in flight');
      const recent = history.filter((entry) => Date.parse(entry.data.created_at) > Date.parse(at) - 30 * 86400000);
      for (const id of [a, b]) if (recent.filter((entry) => [entry.data.a, entry.data.b].includes(id)).length >= settings.intros_per_person_per_30d) fail('introduction cadence reached');
      const reason = required(arg.reason, 'reason'), activity = required(arg.activity, 'activity'), wording = required(arg.text, 'text');
      const attempt = crypto.randomUUID();
      const data = { a, b, attempt_id: attempt, reason, activity, version: 1, a_said: null, b_said: null, state: 'pending', created_at: at, expires_at: days(at, settings.intro_expiry_days), closed_reason: null };
      const file = path.join(introDir(root), `${fileId(a)}--${fileId(b)}--${attempt}.md`);
      putRecord(file, INTRO_KEYS, data, wording);
      const ask = `I thought you and ${one.id === a ? two.name : one.name} might enjoy ${activity}. ${reason} Would you like an introduction? Reply yes or no.`;
      queue(root, a, 'intro_ask', ask, at, attempt);
      const otherAsk = `I thought you and ${one.name} might enjoy ${activity}. ${reason} Would you like an introduction? Reply yes or no.`;
      queue(root, b, 'intro_ask', otherAsk, at, attempt);
      return { a, b, attempt_id: attempt, state: 'pending' };
    }
    if (command === 'sent') {
      const id = required(arg.id, 'message id');
      if (!/^[a-f0-9-]{36}$/.test(id)) fail('invalid message id');
      const file = path.join(outboxDir(root), `${id}.json`);
      const message = json(file);
      if (!message) fail('unknown message');
      message.state = 'sent'; putJson(file, message);
      return { id, state: 'sent' };
    }
    if (command === 'room') {
      const roster = people(root);
      const links = rows(path.join(privateDir(root), 'links.jsonl'));
      const unconnected = roster.filter((entry) => entry.data.status === 'active' && !links.some((link) => [link.a, link.b].includes(entry.data.id))).map((entry) => entry.data.name);
      const celebrate = roster.filter((entry) => entry.data.status !== 'left').flatMap((entry) => { const value = cardValues(published(root, entry.data.id)).worth_celebrating; return value ? [`${entry.data.name}: ${value}`] : []; });
      const flight = intros(root).filter((entry) => ['pending', 'ready'].includes(entry.data.state)).length;
      const recent = roster.filter((entry) => entry.data.status === 'active' && Date.parse(entry.data.joined_at) >= Date.parse(at) - 7 * 86400000).map((entry) => entry.data.name);
      const content = `# Host room\n\nPeople: ${roster.filter((entry) => entry.data.status === 'active').length} active\n\n## No connections recorded\n\n${unconnected.join('\n') || 'None'}\n\n## Worth celebrating\n\n${celebrate.join('\n') || 'Nothing recorded yet'}\n\n## Introductions in flight\n\n${flight}\n\n## Suggested welcomes\n\n${recent.join('\n') || 'None'}\n`;
      atomic(path.join(privateDir(root), 'room.md'), content);
      return { text: content };
    }
    fail('unknown host command');
  });
}

module.exports = { hostAction, DEFAULT_CONFIG };
