'use strict';

// Element for a helper from outside the team (Codex, Devin, Grok, Muse, Claude
// or any tool that can run a command). One loop, all through the CLI:
//
//   connect   the helper takes a seat and reads where the project stands
//   task      a person or a teammate posts a task and tags who does it
//   claim     the helper becomes the owner and gets the handoff
//   progress  one plain line at a time, on the same card
//   complete  the result with proof (and a check that ran), plus one lesson
//   receipt   the whole chain, read back from what was saved
//
// What stays the owner's: an idea the team thought up still waits for the
// owner's yes, protected work (money, deploy, security, customer, external)
// always waits for the owner's yes, and finished work lands in front of the
// owner to accept. Nothing here runs a model: an outside helper works on its
// own tool, so claiming a task never spends the owner's credits.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function core() { return require('./feed-core'); }
function c() { return core()._internal; }
function team() { return require('./feed-team'); }
function ops() { return require('./element-ops'); }

const ENGINES = ['atris', 'codex', 'claude', 'devin', 'grok', 'muse', 'cursor', 'antigravity', 'opencode', 'other'];
const LESSONS_HEADING = '## Element lessons';
const LESSON_MAX = 300;
const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }

function memberFile(root, slug) {
  return path.join(root, 'atris', 'team', slug, 'MEMBER.md');
}

function frontmatterOf(root, slug) {
  try {
    return require('./member-core').parseFrontmatter(fs.readFileSync(memberFile(root, slug), 'utf8')) || {};
  } catch {
    return {};
  }
}

// A seat made by `element connect`: its helper runs on its own tool.
function isOutside(root, slug) {
  const front = frontmatterOf(root, slug);
  return front.external === true || String(front.external || '').trim().toLowerCase() === 'true';
}

function connectionsFile(root) { return ops().stateFile(root, 'connections.json'); }

function existing(root, rels) {
  return rels.filter((rel) => fs.existsSync(path.join(root, rel)));
}

function lessonLines(file, max) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).slice(-max).map((l) => l.slice(2).slice(0, 400));
}

function activeCampaigns(root) {
  try {
    const store = require('./campaign-store');
    const opened = store.openCampaignStore(root);
    const rows = store.listCampaigns(opened) || [];
    return rows.filter((row) => row && !['done', 'stopped'].includes(String(row.state || row.status || '')))
      .slice(0, 5).map((row) => ({ id: row.id, title: c().oneLine(row.title || row.goal || '').slice(0, 160) }));
  } catch {
    return [];
  }
}

function activeMissions(root) {
  try {
    return require('../commands/mission').listMissions(root)
      .filter((m) => !['complete', 'completed', 'stopped', 'failed', 'cancelled'].includes(String(m.status || m.state || '')))
      .slice(0, 5).map((m) => ({ id: m.id, title: m.title || m.objective || m.goal || '', state: m.status || m.state }));
  } catch { return []; }
}

function workView(root, slug, db) {
  const rows = c().workspaceRows(root, db);
  const mine = [];
  const open = [];
  const counts = { open: 0, working: 0, review: 0 };
  for (const row of rows) {
    if (row.status === 'open') counts.open += 1;
    else if (row.status === 'claimed') counts.working += 1;
    else if (row.status === 'review') counts.review += 1;
    const feed = c().feedOf(row.metadata);
    if (!feed.task || !['open', 'claimed'].includes(row.status)) continue;
    const line = { card: c().cardId(row.id, 'proposal'), title: row.title, state: row.status === 'open' ? 'ready to claim' : 'working' };
    const to = String(c().obj(feed.task).to || '');
    if (row.claimed_by === slug || (row.status === 'open' && to === slug)) mine.push(line);
    else if (row.status === 'open' && !to && !claimRefusal(root, row, slug)) open.push(line);
  }
  return { counts, mine: mine.slice(0, 10), open: open.slice(0, 10) };
}

function commandsFor(slug) {
  return {
    task: `atris element task "<what to do>" --as ${slug} --to <teammate>`,
    claim: `atris element claim --as ${slug} --json`,
    ask: `atris element ask <card> --as ${slug} "<question>"`,
    redirect: `atris element redirect <card> --as ${slug} --to <teammate>`,
    progress: `atris element progress <card> --as ${slug} "<one plain line>"`,
    complete: `atris element complete <card> --as ${slug} --proof "<what you ran and what it showed>" --verify "<check command>" --lesson "<one thing worth keeping>" "<one plain line on the result>"`,
    receipt: 'atris element receipt <card> --json',
  };
}

// ------------------------------------------------------------- connect

function connect(root, { as, engine = '', env = process.env } = {}) {
  const k = c();
  const slug = String(as || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(slug)) {
    throw new k.FeedError(400, 'usage: atris element connect --as <name> [--engine codex|claude|devin|grok|muse|atris|other]. The name is 2 to 40 letters, numbers or dashes.');
  }
  const tool = String(engine || '').trim().toLowerCase() || (ENGINES.includes(slug) ? slug : 'other');
  if (!ENGINES.includes(tool)) throw new k.FeedError(400, `engine must be one of: ${ENGINES.join(', ')}`);
  const viewer = k.viewerOf(env);
  const file = memberFile(root, slug);
  let created = false;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '---',
      `name: ${slug}`,
      `role: Outside helper on ${tool}`,
      'external: true',
      `external_engine: ${tool}`,
      `connected_at: ${nowIso()}`,
      '---',
      `# ${slug}`,
      '',
      'An outside helper that joined through Element. It works on its own tool, takes the tasks it is tagged on, reports on the same card and hands every result to the owner to accept.',
      '',
    ].join('\n'));
    created = true;
  }
  // A person's word on a seat stands: a seat nobody has switched comes on at
  // connect (an outside helper costs the owner nothing), one switched off stays off.
  const switches = require('./member-switches');
  const outside = isOutside(root, slug);
  const entry = k.obj(k.obj(switches.loadMemberSwitches(root).members)[slug]);
  if (outside && entry.awake === undefined) switches.setMemberAwake(slug, true, root);
  const on = team().isOn(root, slug);

  const seen = ops().readJson(connectionsFile(root), {});
  seen[slug] = { engine: tool, first_at: (seen[slug] && seen[slug].first_at) || nowIso(), last_at: nowIso(), by: viewer.agent ? 'agent' : viewer.person };
  ops().writeJsonAtomic(connectionsFile(root), seen);

  const db = k.openWrite();
  const work = workView(root, slug, db);
  return {
    version: k.FEED_VERSION,
    connected: true,
    created,
    member: slug,
    engine: tool,
    outside,
    on,
    ...(on ? {} : { why_off: `The owner has ${slug} switched off. They turn it on with: atris feed member on ${slug}` }),
    context: {
      goal: k.themeText(root) || null,
      read_first: existing(root, ['atris/MAP.md', 'atris/atris.md', 'AGENTS.md', 'atris/wiki/index.md']),
      campaigns: activeCampaigns(root),
      missions: activeMissions(root),
      your_lessons: lessonLines(path.join(root, 'atris', 'team', slug, 'lessons.md'), 5),
      tasks: work.counts,
      yours: work.mine,
      open_to_claim: work.open,
      lessons: lessonLines(path.join(root, 'atris', 'lessons.md'), 5),
    },
    commands: commandsFor(slug),
  };
}

// ------------------------------------------------------------- route

function words(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}

// No tag: the task goes to the seat that is on whose name and role share the
// most words with it. No model is asked, so the same task always lands the same way.
function route(root, text, { not = '' } = {}) {
  const want = words(text);
  let best = null;
  for (const slug of c().teamMembers(root)) {
    if (slug === not || !team().isOn(root, slug)) continue;
    const front = frontmatterOf(root, slug);
    const have = words(`${slug} ${front.role || ''} ${front.description || ''}`);
    let score = 0;
    for (const w of want) if (have.has(w)) score += 1;
    if (!best || score > best.score) best = { slug, score };
  }
  return best ? best.slug : '';
}

// ------------------------------------------------------------- task

function postTask(root, { text, as = null, to = null, why = null, detail = null, lane = null, idKey = null, env = process.env, deps = {} } = {}) {
  const k = c();
  const clean = String(text || '').trim();
  if (!clean) throw new k.FeedError(400, 'usage: atris element task "<what to do>" [--as <member>] [--to <teammate>] [--why "<why it matters>"] [--detail "<technical text>"] [--id <key>]');
  const viewer = k.viewerOf(env);
  if (viewer.agent && !as) throw new k.FeedError(403, `Say who is posting: --as <member>. This is running inside an agent (${viewer.agent}).`);
  const poster = as ? k.requireMember(root, as) : null;
  // Only a seat that is on puts anything in front of the owner, the same as every other card.
  if (poster && !team().isOn(root, poster)) throw new k.FeedError(409, `${poster} is off, so it cannot post a task. The owner turns it on with: atris feed member on ${poster}`);
  const key = idKey ? String(idKey).trim() : '';
  const idxFile = ops().stateFile(root, 'idempotency.json');
  if (key) {
    const hit = ops().readJson(idxFile, {})[`task:${key}`];
    if (hit && hit.card_id) return { version: k.FEED_VERSION, card_id: hit.card_id, owner: hit.owner || null, replayed: true, id_key: key };
  }
  const owner = to ? k.requireMember(root, to) : route(root, clean) || poster;
  if (!owner) throw new k.FeedError(409, 'Nobody on the team is on to take this. Tag someone with --to <teammate>, or connect a helper first: atris element connect --as <name>');
  const title = clean.length <= 160 ? k.oneLine(clean) : `${k.oneLine(clean).slice(0, 157)}...`;
  const out = k.proposeCard(root, {
    as: owner,
    title,
    body: clean.length > 160 ? clean : '',
    why: why || 'Asked for directly in Element.',
    detail: detail || undefined,
    lane: lane || undefined,
    unsourced: true,
    env,
  });
  if (!out.card) throw new k.FeedError(500, 'The task was not saved.');
  const parsed = out.card.source && out.card.source.id;
  const db = k.openWrite();
  const tdb = require('./task-db');
  const postedBy = poster ? k.memberRef(poster) : k.personId(env);
  if (out.created) {
    tdb.updateTaskMetadata(db, parsed, (metadata) => {
      metadata.feed = { ...k.obj(metadata.feed), task: { posted_by: postedBy, by_person: !poster && !viewer.agent, to: owner, tagged: Boolean(to), at: nowIso() } };
      metadata.assigned_to = owner;
      return metadata;
    });
  }
  if (out.created) team().recordEvent(root, { member: poster || 'The owner', type: 'task', card_id: out.card.id, text: title }, deps, { board: false });
  let started = null;
  // A person tagging a teammate that runs on this computer is the same yes as
  // Approve. A helper from outside is not started from here: it claims the card.
  if (out.created && !poster && !viewer.agent && !isOutside(root, owner) && !out.card.guarded_lane) {
    try { started = core().decide(root, out.card.id, 'approve', { env, deps }).outcome || {}; } catch (error) { started = { started: false, reason: error.message }; }
  }
  if (key) {
    const index = ops().readJson(idxFile, {});
    index[`task:${key}`] = { card_id: out.card.id, owner, at: nowIso() };
    ops().writeJsonAtomic(idxFile, index);
  }
  return {
    version: k.FEED_VERSION,
    card_id: out.card.id,
    owner,
    posted_by: postedBy,
    created: out.created !== false,
    replayed: false,
    ...(started ? { started: started.started === true, start_reason: started.reason || null } : {}),
    next: isOutside(root, owner) ? `atris element claim ${out.card.id} --as ${owner} --json` : null,
    ...(key ? { id_key: key } : {}),
  };
}

// ------------------------------------------------------------- claim

function approvedByPerson(row) {
  const record = c().decisionOf(row.metadata, c().cardId(row.id, c().feedOf(row.metadata).card_kind || 'proposal'));
  return Boolean(record && record.choice === 'approve');
}

// Why this helper cannot take this work, in plain words, or '' when it can.
function claimRefusal(root, row, slug) {
  const k = c();
  const feed = k.feedOf(row.metadata);
  const task = k.obj(feed.task);
  const approved = approvedByPerson(row);
  if (row.status === 'claimed') return row.claimed_by === slug ? '' : `${row.claimed_by || 'Someone else'} already has this work.`;
  if (row.status !== 'open') return 'This work is already finished.';
  const lane = k.laneOfTask(row);
  if (lane && !approved) return `This is ${lane} work, so it waits for the owner's yes.`;
  if (feed.redirect_idea && !approved) return "This is an idea, so it waits for the owner's yes.";
  if (!feed.task) {
    if (!approved) return "This is an idea, so it waits for the owner's yes.";
    if (String(row.metadata.assigned_to || '') !== slug) return `This work belongs to ${row.metadata.assigned_to || 'another teammate'}.`;
    return isOutside(root, slug) ? '' : `${slug} runs on this computer, so the feed starts its work.`;
  }
  if (task.to && task.tagged && task.to !== slug) return `This task is tagged to ${task.to}.`;
  // A teammate's task with no person behind it yet: the owner can make those wait too.
  const agentTasks = String(k.obj(team().readFeedConfig(root)).agent_tasks || 'on').toLowerCase();
  if (!task.by_person && !approved && agentTasks === 'off') return "The owner asked that a teammate's task waits for their yes.";
  return '';
}

function threadOf(root, cardId, env) {
  try {
    return ops().repliesFor(root, cardId, { env }).slice(-10).map((r) => ({
      by: r.author ? r.author.name : null, text: String(r.text || '').slice(0, 600), at: r.created_at || r.at || null,
    }));
  } catch {
    return [];
  }
}

function handoffFor(root, row, slug, cardId, env) {
  const k = c();
  const feed = k.feedOf(row.metadata);
  const task = k.obj(feed.task);
  const misses = (Array.isArray(feed.history) ? feed.history : []).map(k.obj).filter((h) => h.ended)
    .map((h) => ({ reason: k.oneLine(h.ended).slice(0, 300), at: h.ended_at || null }));
  return {
    task: {
      title: row.title,
      body: feed.body || null,
      why: feed.why || null,
      detail: feed.detail || null,
      asked_by: task.posted_by || feed.created_by || feed.author || null,
      lane: k.laneOfTask(row) || null,
    },
    goal: k.themeText(root) || null,
    thread: threadOf(root, cardId, env),
    earlier_tries: misses,
    ask: feed.ask || null,
    passed_on: (() => {
      const last = (Array.isArray(feed.redirects) ? feed.redirects : []).slice(-1)[0];
      return last && last.to === slug ? { from: last.from, note: last.note, progress: (Array.isArray(feed.progress) ? feed.progress : []).map((p) => p.text) } : null;
    })(),
    read_first: existing(root, ['atris/MAP.md', 'atris/atris.md', 'AGENTS.md']),
    lessons: [
      ...lessonLines(path.join(root, 'atris', 'team', slug, 'lessons.md'), 5),
      ...lessonLines(path.join(root, 'atris', 'lessons.md'), 5),
    ],
    report_with: {
      progress: `atris element progress ${cardId} --as ${slug} "<one plain line>"`,
      complete: `atris element complete ${cardId} --as ${slug} --proof "<what you ran and what it showed>" --verify "<check command>" --lesson "<one thing worth keeping>" "<one plain line on the result>"`,
      ask: `atris element ask ${cardId} --as ${slug} "<your question>"`,
    },
    rules: [
      'You own this card until you finish it or your hold runs out.',
      'Finished work goes to the owner to accept. Nothing is sent, paid, deleted or released without them.',
    ],
  };
}

async function claim(root, { as, card = null, leaseMs = DEFAULT_LEASE_MS, waitMs = 0, intervalMs = 200, env = process.env, now = () => Date.now() } = {}) {
  const k = c();
  const holder = String(as || '').trim();
  if (!holder) throw new k.FeedError(400, 'usage: atris element claim [<card>] --as <member> [--lease 30m] [--wait 30s]');
  const slug = k.requireMember(root, holder);
  if (!team().isOn(root, slug)) throw new k.FeedError(409, `${slug} is off, so it cannot take work. The owner turns it on with: atris feed member on ${slug}`);
  const leaseFile = ops().stateFile(root, 'leases.json');
  const tdb = require('./task-db');
  const wanted = card ? String(card).trim() : '';

  function tryClaim() {
    const nowMs = now();
    const db = k.openWrite();
    const saved = ops().readJson(leaseFile, {});
    const leases = ops().activeLeases(saved, nowMs);
    let rows;
    if (wanted) {
      rows = [k.cardAndTask(root, db, wanted).row];
    } else {
      rows = k.workspaceRows(root, db).filter((row) => ['open', 'claimed'].includes(row.status))
        .sort((a, b) => {
          const mine = (row) => (String(k.obj(k.feedOf(row.metadata).task).to || row.metadata.assigned_to || '') === slug ? 0 : 1);
          return mine(a) - mine(b) || a.created_at - b.created_at;
        });
    }
    let refusal = '';
    for (let row of rows) {
      const cardId = k.cardId(row.id, k.feedOf(row.metadata).card_kind || 'proposal');
      const lease = leases[cardId];
      const openAsk = k.obj(k.feedOf(row.metadata).ask);
      if (openAsk.text && !openAsk.answered_at && (row.claimed_by || row.metadata.assigned_to) !== slug) { refusal = "This card is waiting for the owner's answer."; continue; }
      // A helper that went quiet past its hold lets the card go to the next one.
      if (row.status === 'claimed' && row.claimed_by !== slug && saved[cardId] && !lease && k.feedOf(row.metadata).claim) {
        const let_go = tdb.releaseTask(db, { id: row.id, actor: row.claimed_by, reason: `the hold ran out and ${slug} took it over` });
        if (let_go && let_go.released) row = { ...tdb.getTask(db, row.id) };
        row.metadata = k.obj(row.metadata);
      }
      if (lease && lease.holder !== slug) { refusal = `${lease.holder} holds this card until ${lease.expires_at}.`; continue; }
      const why = claimRefusal(root, row, slug);
      if (why) { refusal = why; continue; }
      const again = row.status === 'claimed' && row.claimed_by === slug;
      if (!again) {
        k.dropHold(db, row, slug);
        const won = tdb.claimTask(db, { id: row.id, claimedBy: slug });
        if (!won || !won.claimed) { refusal = 'Someone else took this work first.'; continue; }
      }
      const handoff = handoffFor(root, row, slug, cardId, env);
      const stamp = new Date(nowMs).toISOString();
      tdb.updateTaskMetadata(db, row.id, (metadata) => {
        const feed = k.obj(metadata.feed);
        const before = k.obj(feed.claim);
        metadata.assigned_to = slug;
        metadata.feed = {
          ...feed,
          claim: {
            by: slug,
            at: before.by === slug && before.at ? before.at : stamp,
            engine: frontmatterOf(root, slug).external_engine || null,
            outside: isOutside(root, slug),
            handoff: {
              given_at: stamp,
              asked_by: handoff.task.asked_by,
              goal: handoff.goal,
              read_first: handoff.read_first,
              thread_messages: handoff.thread.length,
              lessons: handoff.lessons.length,
              earlier_tries: handoff.earlier_tries.length,
            },
          },
        };
        return metadata;
      });
      const leaseRow = {
        card_id: cardId,
        holder: slug,
        claimed_at: stamp,
        expires_at: new Date(nowMs + leaseMs).toISOString(),
        expires_at_ms: nowMs + leaseMs,
      };
      ops().writeJsonAtomic(leaseFile, { ...leases, [cardId]: leaseRow });
      if (!again) {
        try { team().recordEvent(root, { member: slug, type: 'claimed', card_id: cardId, text: `took: ${k.oneLine(row.title).slice(0, 200)}` }, {}, { board: false }); } catch {}
      }
      const fresh = tdb.getTask(db, row.id);
      const view = k.cardsForRow(root, { ...fresh, metadata: k.obj(fresh.metadata) })[0] || { id: cardId, title: row.title };
      return { version: k.FEED_VERSION, claimed: true, lease: leaseRow, card: view, owner: slug, handoff };
    }
    if (wanted) throw new k.FeedError(409, refusal || 'This card cannot be claimed.');
    return null;
  }

  const first = tryClaim();
  if (first) return first;
  const deadline = now() + Math.max(0, waitMs);
  const step = Math.max(25, Math.min(intervalMs, 2000));
  while (now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, Math.max(10, deadline - now()))));
    const hit = tryClaim();
    if (hit) return hit;
  }
  return { version: k.FEED_VERSION, claimed: false, lease: null, card: null };
}

// ------------------------------------------------------------- ask and redirect

function ask(root, cardId, { as, text = '', answer = false, env = process.env, deps = {} } = {}) {
  const k = c();
  const slug = k.requireMember(root, as);
  const db = k.openWrite();
  const { row } = k.cardAndTask(root, db, cardId);
  if (String(row.metadata.assigned_to || row.claimed_by || '') !== slug) throw new k.FeedError(403, `${slug} is not the one doing this work.`);
  const feed = k.feedOf(row.metadata);
  if (answer) {
    if (String(text).trim()) throw new k.FeedError(400, 'Use --answer without a question.');
    return { version: k.FEED_VERSION, card_id: cardId, ask: feed.ask || null };
  }
  const question = k.oneLine(text);
  if (!question) throw new k.FeedError(400, 'Write a question.');
  k.requirePlain('question', question);
  if (feed.ask && !feed.ask.answered_at) throw new k.FeedError(409, `The open question is: ${feed.ask.text}`, { ask: feed.ask });
  if (row.status !== 'claimed') throw new k.FeedError(409, 'Claim this work before asking.');
  require('./feed-room').reply(root, cardId, question, { as: slug, env, deps, ownerQuestion: true });
  const entry = { by: slug, text: question, at: nowIso(), answered_at: null, answer: null };
  const hadHold = Array.isArray(row.metadata.tags) && row.metadata.tags.includes('needs-human');
  require('./task-db').updateTaskMetadata(db, row.id, (metadata) => {
    const f = k.obj(metadata.feed);
    metadata.tags = [...new Set([...(Array.isArray(metadata.tags) ? metadata.tags : []), 'needs-human'])];
    metadata.feed = { ...f, ask_had_hold: hadHold, ask: entry, asks: [...(Array.isArray(f.asks) ? f.asks : []), entry] };
    return metadata;
  });
  return { version: k.FEED_VERSION, card_id: cardId, ask: entry };
}

function redirect(root, cardId, { as = null, to, note = '', env = process.env, deps = {} } = {}) {
  const k = c();
  const viewer = k.viewerOf(env);
  if (viewer.agent && !as) throw new k.FeedError(403, 'Say who is passing this work with --as <member>.');
  const actor = as ? k.requireMember(root, as) : null;
  const target = String(to || '').trim().toLowerCase();
  if (!target || !k.teamMembers(root).includes(target)) throw new k.FeedError(409, 'That teammate is not on the team.');
  if (!team().isOn(root, target)) throw new k.FeedError(409, `${target} is off, so it cannot take work.`);
  const db = k.openWrite();
  const { row } = k.cardAndTask(root, db, cardId);
  if (!['open', 'claimed'].includes(row.status)) throw new k.FeedError(409, 'This work is already finished.');
  const from = String(row.claimed_by || row.metadata.assigned_to || '') || null;
  if (actor && actor !== from) throw new k.FeedError(403, `${actor} is not the one doing this work.`);
  if (from === target) throw new k.FeedError(400, `${target} already has this work.`);
  const cleanNote = k.oneLine(note);
  if (cleanNote) k.requirePlain('note', cleanNote);
  const tdb = require('./task-db');
  if (row.status === 'claimed') tdb.releaseTask(db, { id: row.id, actor: row.claimed_by, reason: 'passed to a teammate' });
  ops().releaseLease(root, cardId);
  const entry = { from, to: target, by: actor || k.personId(env), by_person: !actor && !viewer.agent, note: cleanNote || null, at: nowIso() };
  tdb.updateTaskMetadata(db, row.id, (metadata) => {
    const f = k.obj(metadata.feed);
    metadata.assigned_to = target;
    metadata.feed = { ...f, author: k.memberRef(target), redirect_idea: f.redirect_idea || !f.task, task: { ...k.obj(f.task), to: target, tagged: true }, redirects: [...(Array.isArray(f.redirects) ? f.redirects : []), entry] };
    return metadata;
  });
  team().recordEvent(root, { member: actor || 'The owner', type: 'passed', card_id: cardId, text: `to ${target}${cleanNote ? ': ' + cleanNote : ''}` }, deps, { board: false });
  let started = null;
  if (entry.by_person && !isOutside(root, target) && !k.laneOfTask(row) && Boolean(k.feedOf(row.metadata).task) && !approvedByPerson(row)) {
    try { started = core().decide(root, cardId, 'approve', { env, deps }).outcome || {}; } catch (error) { started = { started: false, reason: error.message }; }
  }
  return { version: k.FEED_VERSION, card_id: cardId, redirect: entry, ...(started ? { started: started.started === true, start_reason: started.reason || null } : {}) };
}

function nextCard(root, slug, db) {
  if (!team().isOn(root, slug)) return null;
  const k = c();
  const saved = ops().readJson(ops().stateFile(root, 'leases.json'), {});
  const leases = ops().activeLeases(saved, Date.now());
  const rows = k.workspaceRows(root, db).filter((row) => ['open', 'claimed'].includes(row.status)).sort((a, b) => {
    const mine = (row) => String(k.obj(k.feedOf(row.metadata).task).to || row.metadata.assigned_to || '') === slug ? 0 : 1;
    return mine(a) - mine(b) || a.created_at - b.created_at;
  });
  for (const original of rows) {
    let row = original;
    const id = k.cardId(row.id, k.feedOf(row.metadata).card_kind || 'proposal');
    const ask = k.obj(k.feedOf(row.metadata).ask);
    if (ask.text && !ask.answered_at && (row.claimed_by || row.metadata.assigned_to) !== slug) continue;
    if (leases[id] && leases[id].holder !== slug) continue;
    if (row.status === 'claimed' && row.claimed_by !== slug && saved[id] && !leases[id] && k.feedOf(row.metadata).claim) row = { ...row, status: 'open', claimed_by: null };
    if (!claimRefusal(root, row, slug)) return { card: id, title: row.title, claim: `atris element claim ${id} --as ${slug} --json` };
  }
  return null;
}

// ------------------------------------------------------------- progress

function progress(root, cardId, { as, text, env = process.env, deps = {} } = {}) {
  const k = c();
  if (!cardId || !String(text || '').trim()) throw new k.FeedError(400, 'usage: atris element progress <card> --as <member> "<one plain line>"');
  const out = team().emit(root, { as, type: 'progress', card: cardId, text, env, deps });
  return { version: k.FEED_VERSION, card_id: cardId, progress: out.event ? out.event.text : k.oneLine(text) };
}

// ------------------------------------------------------------- complete

function runVerify(root, command, deps = {}) {
  if (deps.verify) return deps.verify(command);
  const started = Date.now();
  const run = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const tail = `${run.stdout || ''}\n${run.stderr || ''}`.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 400);
  return { exit: run.status === null ? 124 : run.status, ms: Date.now() - started, tail };
}

function saveLesson(root, slug, lesson, title, cardId) {
  const file = path.join(root, 'atris', 'team', slug, 'lessons.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const line = `- ${lesson} (from "${String(title || '').replace(/"/g, "'").slice(0, 120)}", ${nowIso().slice(0, 10)}, ${cardId})`;
  if (text.includes(`, ${cardId})`) && text.includes(`- ${lesson} (`)) return { file: path.relative(root, file), line, saved: true };
  const at = text.indexOf(LESSONS_HEADING);
  let next;
  if (at < 0) next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${LESSONS_HEADING}\n\n${line}\n`;
  else {
    const rest = text.slice(at);
    const end = rest.slice(LESSONS_HEADING.length).search(/\n##\s/);
    const cut = end < 0 ? text.length : at + LESSONS_HEADING.length + end;
    next = `${text.slice(0, cut).replace(/\n*$/, '\n')}${line}\n${text.slice(cut)}`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, next);
  fs.renameSync(temp, file);
  return { file: path.relative(root, file), line, saved: true };
}

function complete(root, cardId, { as, proof, text = '', lesson = '', verify = '', env = process.env, deps = {} } = {}) {
  const k = c();
  if (!cardId || !String(proof || '').trim()) {
    throw new k.FeedError(400, 'usage: atris element complete <card> --as <member> --proof "<what you ran and what it showed>" [--verify "<check command>"] [--lesson "<one thing worth keeping>"] ["<one plain line on the result>"]');
  }
  const slug = k.requireMember(root, as);
  const plain = require('./feed-plain-words');
  const learned = k.oneLine(lesson || '');
  if (learned.length > LESSON_MAX) throw new k.FeedError(400, `Keep the lesson under ${LESSON_MAX} characters.`);
  if (learned && plain.holdsKey(learned)) throw new k.FeedError(400, plain.SECRET_REFUSED, { field: 'lesson', code: 'holds_key' });
  const db = k.openWrite();
  const { row } = k.cardAndTask(root, db, cardId);
  const owner = String(row.metadata.assigned_to || row.claimed_by || '');
  if (owner !== slug) throw new k.FeedError(403, `${slug} is not the one doing this work, so it cannot finish it. Claim it first: atris element claim ${cardId} --as ${slug}`);
  // The check runs before anything is written: a result whose check fails is not a result.
  let check = null;
  const command = String(verify || '').trim();
  if (command) {
    if (plain.holdsKey(command)) throw new k.FeedError(400, plain.SECRET_REFUSED, { field: 'verify', code: 'holds_key' });
    const ran = runVerify(root, command, deps);
    check = { command: command.slice(0, 500), exit: ran.exit, passed: ran.exit === 0, ms: ran.ms || 0, tail: ran.tail || '', at: nowIso() };
    if (!check.passed) {
      throw new k.FeedError(409, `The check did not pass (exit ${check.exit}), so the result was not taken: ${check.tail || command}`, { check });
    }
  }
  const out = team().emit(root, { as: slug, type: 'result', card: cardId, proof, text: text || undefined, env, deps });
  const tdb = require('./task-db');
  const saved = learned ? saveLesson(root, slug, learned, row.title, cardId) : null;
  tdb.updateTaskMetadata(db, row.id, (metadata) => {
    const feed = k.obj(metadata.feed);
    metadata.feed = {
      ...feed,
      result: { by: slug, at: nowIso(), ...(check ? { check } : {}), ...(saved ? { lesson: { text: learned, file: saved.file } } : {}) },
    };
    if (learned) metadata.latest_agent_lesson = learned;
    return metadata;
  });
  ops().releaseLease(root, cardId);
  const next = nextCard(root, slug, db);
  return {
    version: k.FEED_VERSION,
    completed: true,
    card_id: cardId,
    owner: slug,
    check,
    lesson: saved ? { text: learned, file: saved.file } : null,
    result: out,
    next_card: next,
    next: next ? 'The owner accepts it in Element. Another card is ready to claim.' : 'The owner accepts it in Element. No card is ready to claim now.',
  };
}

// ------------------------------------------------------------- receipt

// The chain as it was saved, not as anyone remembers it: who asked, who took
// it and what they were handed, what they said along the way, the result, its
// proof and check, and the lesson where it now lives.
function receipt(root, cardId) {
  const k = c();
  if (!cardId) throw new k.FeedError(400, 'usage: atris element receipt <card> [--json]');
  const db = k.openWrite();
  const { row } = k.cardAndTask(root, db, cardId);
  const meta = row.metadata;
  const feed = k.feedOf(meta);
  const task = k.obj(feed.task);
  const took = k.obj(feed.claim);
  const result = k.obj(feed.result);
  const lesson = k.obj(result.lesson);
  let lessonSaved = false;
  if (lesson.file && lesson.text) {
    try { lessonSaved = fs.readFileSync(path.join(root, lesson.file), 'utf8').includes(`- ${lesson.text} (`); } catch {}
  }
  const proof = String(meta.latest_agent_proof || '').trim();
  const handedIn = ['review', 'done'].includes(row.status);
  const steps = {
    posted: Boolean(task.posted_by || feed.created_by),
    handoff: Boolean(k.obj(took.handoff).given_at),
    owner: Boolean(took.by) && (row.claimed_by === took.by || meta.assigned_to === took.by),
    result: handedIn && Boolean(proof) && result.by === took.by,
    checked: Boolean(k.obj(result.check).passed),
    lesson: lessonSaved,
  };
  const progressLines = (Array.isArray(feed.progress) ? feed.progress : []).map((p) => ({ at: p.at, by: p.by, text: p.text }));
  return {
    version: k.FEED_VERSION,
    card_id: cardId,
    task_id: row.id,
    title: row.title,
    state: row.status === 'review' ? 'waiting for the owner to accept' : row.status === 'done' ? 'accepted' : row.status === 'claimed' ? 'working' : row.status,
    posted_by: task.posted_by || feed.created_by || null,
    owner: took.by || null,
    owner_engine: took.engine || null,
    owner_outside: took.outside === true,
    claimed_at: took.at || null,
    handoff: took.handoff || null,
    progress: progressLines,
    asks: Array.isArray(feed.asks) ? feed.asks : [],
    redirects: Array.isArray(feed.redirects) ? feed.redirects : [],
    result: handedIn ? (Array.isArray(feed.story) && feed.story[0]) || meta.result || null : null,
    proof: proof || null,
    check: result.check || null,
    lesson: lesson.text ? { text: lesson.text, file: lesson.file, saved: lessonSaved } : null,
    steps,
    complete: Object.values(steps).every(Boolean),
  };
}

module.exports = {
  ask,
  redirect,
  claim,
  complete,
  connect,
  isOutside,
  postTask,
  progress,
  receipt,
};
