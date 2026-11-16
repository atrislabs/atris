'use strict';

// atris nexus, network tools: groups, the shape of the network, and saved lists
// (backend routers/nexus_router.py: GET /nexus/groups, POST /nexus/groups/open,
// GET /nexus/network, /nexus/lists). Same login and same store as commands/nexus-store.js,
// with one difference: these routes have no saved-list fallback. When the store cannot
// answer, the command stops with one plain line. Nothing is ever read from or written to
// the old people file.
//
// Labels, list names, search words and people's names travel in a POST body only. The only
// thing that ever sits in a web address is a saved list's own id, which the store handed us.

const crypto = require('node:crypto');
const { NOT_LOGGED_IN } = require('../lib/developer-api');
const N = require('../lib/nexus-network');
const S = require('../lib/nexus-store');
const store = require('./nexus-store');

const WAIT_MS = 15000;
const NEEDS_NEWER = 'This needs a newer Atris. Try again after the next update.';
const DUPLICATE = 'You already have a list with that name.';
const NO_ANSWER = 'The people store did not answer. Try again in a moment.';
const NOT_SAVED = 'That did not save. Try again in a moment.';
const LIMIT_MOST = 200;
const PAGE = 100; // one page of a group when --all walks through every person
const PAGE_DEFAULT = 50;
const PAGES_MOST = 500; // a stop for a store that never ends a page walk

const SUBS = new Set(['groups', 'group', 'network', 'lists', 'save']);
const enc = encodeURIComponent;

/**
 * The store for the network routes. Every failure becomes one plain StoreError; nothing here
 * throws StoreDown, so the caller never falls back to the saved list.
 *   missing   what a 404 means once the store has answered us (the group or list is gone)
 *   conflict  what a 409 means here (a list name already taken)
 *   read      a POST that only reads
 */
function networkClient(request, token) {
  let alive = false;
  const call = async (method, pathname, body, options = {}) => {
    const { missing, conflict, read, ...rest } = options;
    const result = await request(pathname, {
      token,
      method,
      timeoutMs: WAIT_MS,
      ...(body === undefined ? {} : { body }),
      ...rest,
    });
    if (result.ok) {
      alive = true;
      return result.data && typeof result.data === 'object' ? result.data : {};
    }
    const status = result.status;
    if (status === 401) throw new store.StoreError(`Sign in to see your people. ${NOT_LOGGED_IN}`);
    if (status === 402) throw new store.StoreLocked(store.LOCKED_LINE);
    // A 404 from a store that has not answered yet is a store that is too old for these routes.
    // After it has answered, a 404 is the one thing we asked about being gone.
    if (status === 404) throw new store.StoreError(alive && missing ? missing : NEEDS_NEWER);
    if (status === 405) throw new store.StoreError(NEEDS_NEWER);
    if (status === 409 && conflict) throw new store.StoreError(conflict);
    if (status === 503) throw new store.StoreError(store.PAUSED_LINE);
    if (status === 0 || status >= 500) throw new store.StoreError(method !== 'GET' && !read ? NOT_SAVED : NO_ANSWER);
    throw new store.StoreError(S.plainError(result));
  };
  return {
    get: (pathname) => call('GET', pathname),
    // A repeat of a change could be applied twice, so these are sent once unless the caller says so.
    post: (pathname, body, options = { retries: 0 }) => call('POST', pathname, body, options),
    patch: (pathname, body, options = { retries: 0 }) => call('PATCH', pathname, body, options),
    del: (pathname, options = { retries: 0 }) => call('DELETE', pathname, undefined, options),
  };
}

/** What a sub-command needs from its words, checked before any call. { error } or { args }. */
function prepare(sub, words, flags) {
  if (sub === 'groups') {
    if (words.length > 1) return { error: 'atris nexus groups takes no words. To narrow it down: atris nexus groups --kind company' };
    if (flags.kind === undefined) return { args: {} };
    const kind = String(flags.kind).trim().toLowerCase();
    if (!N.KINDS.includes(kind)) return { error: `"${flags.kind}" is not a kind of group. Use ${N.KINDS.join(', ')}.` };
    return { args: { kind } };
  }

  if (sub === 'network') {
    if (words.length > 1) return { error: 'atris nexus network takes no words.' };
    return { args: {} };
  }

  if (sub === 'group') {
    const kind = String(words[1] || '').trim().toLowerCase();
    const label = words.slice(2).join(' ').trim();
    if (!kind || !label) return { error: 'atris nexus group needs a kind and a label, like: atris nexus group company "Sample Co"' };
    if (!N.KINDS.includes(kind)) return { error: `"${words[1]}" is not a kind of group. Use ${N.KINDS.join(', ')}.` };
    const args = { kind, label, limit: PAGE_DEFAULT };
    if (flags.limit !== undefined) {
      args.limit = store.whole(flags.limit, 1, LIMIT_MOST);
      if (args.limit === null) return { error: `--limit takes a whole number from 1 to ${LIMIT_MOST}` };
      args.limitGiven = true;
    }
    return { args };
  }

  if (sub === 'save') {
    if (words.length !== 2) return { error: 'atris nexus save needs one list name, in quotes, like: atris nexus save "Austin founders" --from company "Sample Co"' };
    const named = N.listName(words[1]);
    if (named.error) return { error: named.error };
    const args = { name: named.name, helper: !!flags['as-helper'] };
    const given = [flags.from !== undefined, flags.ids !== undefined].filter(Boolean).length;
    if (given > 1) return { error: 'Use only one of --from and --ids.' };
    if (flags.from !== undefined) {
      const kind = String(flags.from).trim().toLowerCase();
      const label = String(flags.fromLabel || '').trim();
      if (!N.KINDS.includes(kind)) return { error: `"${flags.from}" is not a kind of group. Use ${N.KINDS.join(', ')}.` };
      if (!label) return { error: '--from needs a kind and a label, like: --from company "Sample Co"' };
      args.from = { kind, label };
    } else if (flags.ids !== undefined) {
      const parsed = N.parseIds([flags.ids]);
      if (parsed.error) return { error: parsed.error };
      args.ids = parsed.ids;
    } else {
      args.stdin = true;
    }
    return { args };
  }

  if (sub === 'lists') {
    const action = words[1];
    if (action === undefined) return { args: { action: 'show' } };
    if (action === 'add' || action === 'remove') {
      if (words.length < 4) return { error: `atris nexus lists ${action} needs a list name and person ids, like: atris nexus lists ${action} "Austin founders" <id> <id>` };
      const named = N.listName(words[2]);
      if (named.error) return { error: named.error };
      const parsed = N.parseIds(words.slice(3));
      if (parsed.error) return { error: parsed.error };
      return { args: { action, name: named.name, ids: parsed.ids } };
    }
    if (action === 'rename') {
      if (words.length !== 4) return { error: 'atris nexus lists rename needs the old name and the new name, in quotes, like: atris nexus lists rename "Old name" "New name"' };
      const from = N.listName(words[2]);
      const to = N.listName(words[3]);
      if (from.error || to.error) return { error: from.error || to.error };
      return { args: { action, name: from.name, to: to.name } };
    }
    if (action === 'delete') {
      if (words.length !== 3) return { error: 'atris nexus lists delete needs one list name, in quotes, and --yes' };
      const named = N.listName(words[2]);
      if (named.error) return { error: named.error };
      if (!flags.yes) return { error: `This removes the list "${named.name}" and never the people in it. Run it again with --yes to go ahead.` };
      return { args: { action, name: named.name } };
    }
    return { error: 'atris nexus lists takes add, remove, rename or delete. To see your lists: atris nexus lists' };
  }

  return { args: {} };
}

/** Several things matched one word: list them and stop. Returns the exit code. */
function ambiguous(ctx, what, word, matches) {
  const shown = matches.slice(0, 10);
  const message = `${matches.length} ${what} match "${word}". Use the key to pick one.`;
  if (ctx.json) {
    ctx.log(JSON.stringify({ ok: false, error: message, matches: shown, total: matches.length }));
  } else {
    ctx.err(message);
    for (const m of shown) ctx.err(`  ${m.label}  ${S.plural(m.count, 'person', 'people')}  key: ${m.key}`);
    if (matches.length > shown.length) ctx.err(`  and ${matches.length - shown.length} more`);
  }
  return 1;
}

/** The saved list a name points at: { row } or { stop }. Reads every saved list, then matches here. */
async function findList(ctx, client, word) {
  const data = await client.get('/nexus/lists');
  const lists = Array.isArray(data.lists) ? data.lists : [];
  const found = N.matchList(lists, word);
  if (found.list) return { row: found.list };
  if (found.matches) {
    return { stop: ambiguous(ctx, 'saved lists', word, found.matches.map((l) => ({ kind: 'saved', key: String(l.id), label: String(l.name), count: Number(l.count) || 0 }))) };
  }
  return { stop: ctx.fail(`No saved list called "${word}". See them: atris nexus lists`) };
}

/**
 * The group a label points at: the exact key first, then the label in any case, read from the
 * store's own groups. { group } or { stop }. A label the store does not list (it lists only
 * the biggest 50, and groups of two or more) is tried by the key its words make.
 */
async function findGroup(ctx, client, kind, word) {
  const data = await client.get('/nexus/groups');
  const kinds = Array.isArray(data.kinds) ? data.kinds : [];
  const entry = kinds.find((k) => k && k.kind === kind);
  const groups = entry && Array.isArray(entry.groups) ? entry.groups : [];
  const found = N.matchGroup(groups, word);
  if (found.group) return { group: N.groupRef(kind, found.group) };
  if (found.matches) return { stop: ambiguous(ctx, 'groups', word, found.matches.map((g) => N.groupRef(kind, g))) };
  if (kind === 'saved') {
    const list = await findList(ctx, client, word);
    return list.stop !== undefined ? list : { group: N.groupRef('saved', { key: list.row.id, label: list.row.name, count: list.row.count }) };
  }
  if (N.LABEL_KEYED.has(kind)) return { group: { kind, key: N.keyOf(word), label: word, count: 0, guessed: true } };
  return { stop: ctx.fail(`No ${N.NOUN[kind]} called "${word}" in your network.`) };
}

const noGroup = (group) => `No ${N.NOUN[group.kind]} called "${group.label}" in your network.`;

/** Everything pipe-fed on standard input, or null when it is a keyboard. */
function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    if (stream.isTTY) {
      resolve(null);
      return;
    }
    let all = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { all += chunk; });
    stream.on('end', () => resolve(all));
    stream.on('error', reject);
  });
}

async function run(ctx) {
  const { sub, flags, json, log, fail } = ctx;
  const args = ctx.prep.args;
  const client = networkClient(ctx.request, ctx.token);
  const out = (data) => log(JSON.stringify(data));
  const countOf = (list) => (list && list.count !== undefined ? list.count : 0);

  if (sub === 'groups') {
    const data = await client.get('/nexus/groups');
    const kinds = Array.isArray(data.kinds) ? data.kinds : [];
    const lines = N.groupsLines(kinds, args.kind || '');
    if (json) {
      out(args.kind ? { ...data, kinds: kinds.filter((k) => k && k.kind === args.kind) } : data);
      return 0;
    }
    if (!lines.length) {
      log(args.kind ? `No ${N.HEADING[args.kind].toLowerCase()} yet.` : 'No groups yet. Add people first: atris nexus add "<name>"');
      return 0;
    }
    for (const line of lines) log(line);
    return 0;
  }

  if (sub === 'group') {
    const found = await findGroup(ctx, client, args.kind, args.label);
    if (found.stop !== undefined) return found.stop;
    const { group } = found;
    const open = (cursor, limit) => client.post(
      '/nexus/groups/open',
      { kind: group.kind, key: group.key, limit, cursor: cursor || null },
      { read: true, missing: noGroup(group) },
    );
    const size = flags.all ? (args.limitGiven ? args.limit : PAGE) : args.limit;
    const first = await open(null, size);
    const people = Array.isArray(first.people) ? [...first.people] : [];
    let cursor = first.next_cursor || null;
    if (flags.all) {
      const seen = new Set();
      for (let pages = 1; cursor && !seen.has(cursor) && pages < PAGES_MOST; pages++) {
        seen.add(cursor);
        const next = await open(cursor, size);
        people.push(...(Array.isArray(next.people) ? next.people : []));
        cursor = next.next_cursor || null;
      }
    }
    const whole = { ...first, people, next_cursor: cursor };
    if (json) {
      out(whole);
      return 0;
    }
    for (const line of N.groupLines(whole, ctx.now)) log(line);
    const total = Number(first.group && first.group.count) || people.length;
    if (cursor) log(`\nShowing ${people.length} of ${total}. Add --all for everyone.`);
    return 0;
  }

  if (sub === 'network') {
    const data = await client.get('/nexus/network');
    if (json) out(data);
    else for (const line of N.networkLines(data)) log(line);
    return 0;
  }

  if (sub === 'save') {
    let body;
    let missing;
    if (args.from) {
      const found = await findGroup(ctx, client, args.from.kind, args.from.label);
      if (found.stop !== undefined) return found.stop;
      body = { from: { kind: found.group.kind, key: found.group.key } };
      missing = noGroup(found.group);
    } else {
      let ids = args.ids;
      if (!ids) {
        const piped = await (ctx.readStdin || readStdin)();
        if (piped === null || piped === undefined) return ctx.bad('Say who to save: --from <kind> "<label>", --ids id1,id2, or send person ids on standard input, one per line.');
        const parsed = N.parseIds([piped]);
        if (parsed.error) return ctx.bad(parsed.error);
        ids = parsed.ids;
      }
      body = { person_ids: ids };
    }
    const sent = { name: args.name, ref: (ctx.newRef || crypto.randomUUID)(), ...body, made_by: args.helper ? 'helper' : 'me' };
    // The same ref gives the same answer, so this one change can safely be sent twice.
    const done = await client.post('/nexus/lists', sent, { conflict: DUPLICATE, missing, retries: 1 });
    if (json) {
      out(done);
      return 0;
    }
    const list = done.list || {};
    log(`Saved "${list.name || args.name}": ${S.plural(Number(countOf(list)) || 0, 'person', 'people')}, ${Number(done.skipped) || 0} skipped.`);
    if (Number(done.skipped) > 0) log('Skipped people are not on your list, so they were left out.');
    if (done.replayed) log('This save had already gone through, so nothing was added twice.');
    return 0;
  }

  if (sub === 'lists') {
    if (args.action === 'show') {
      const data = await client.get('/nexus/lists');
      if (json) out(data);
      else for (const line of N.listsLines(Array.isArray(data.lists) ? data.lists : [])) log(line);
      return 0;
    }
    const found = await findList(ctx, client, args.name);
    if (found.stop !== undefined) return found.stop;
    const { row } = found;
    const here = `/nexus/lists/${enc(row.id)}`;
    const gone = `The saved list "${row.name}" is gone. See your lists: atris nexus lists`;

    if (args.action === 'add' || args.action === 'remove') {
      const adding = args.action === 'add';
      const done = await client.post(`${here}/people`, { add: adding ? args.ids : [], remove: adding ? [] : args.ids }, { retries: 0, missing: gone });
      if (json) {
        out(done);
        return 0;
      }
      const list = done.list || {};
      const skipped = Number(done.skipped) || 0;
      log(`${adding ? 'Added to' : 'Removed from'} "${list.name || row.name}". It has ${S.plural(Number(countOf(list)) || 0, 'person', 'people')} now${skipped ? `, ${skipped} skipped` : ''}.`);
      return 0;
    }

    if (args.action === 'rename') {
      const done = await client.patch(here, { name: args.to }, { retries: 0, missing: gone, conflict: DUPLICATE });
      if (json) out(done);
      else log(`Renamed "${row.name}" to "${(done.list && done.list.name) || args.to}".`);
      return 0;
    }

    if (args.action === 'delete') {
      const done = await client.del(here, { retries: 0, missing: gone });
      if (json) out(done);
      else log(`Deleted the list "${row.name}". The people on it are still on your list.`);
      return 0;
    }
  }

  return fail('That command is not known.');
}

module.exports = { SUBS, prepare, run, findList, networkClient, readStdin, NEEDS_NEWER, DUPLICATE };
