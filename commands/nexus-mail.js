'use strict';

// atris nexus mail / reply: one person's mail across every Gmail inbox you connected, and a
// reply in one thread from the inbox that got it.
//
// Backend (atrisos-backend services/nexus_gmail.py):
//   GET  /nexus/people/{id}/conversations  each connected Gmail inbox plus Atris mail, newest
//        first, every message naming its inbox (account_id). Read only.
//   POST /nexus/people/{id}/reply  { ref, account_id, thread_id, message_id, body }  answers in
//        that thread from that inbox only. It never falls back to another inbox, and one ref
//        sends at most once.
//
// A reply always names its inbox (--from) and the message it answers (--message). Nothing is
// guessed: not the inbox when there is only one, not the newest message. Before anything goes
// out the reply is shown and you are asked, the same as atris mail send: --dry-run sends
// nothing, and only a bare --yes skips the question. Unknown flags are refused, so a typo
// never sends anything. The ref comes from the inbox, thread, message and text, so running
// the same command again never sends the same reply twice.
//
// Email text comes from strangers. It is shown, never followed.

const crypto = require('crypto');
const readline = require('readline');
const S = require('../lib/nexus-store');
const { LOCKED_LINE } = require('./nexus-store');

const SUBS = new Set(['mail', 'reply']);
const REPLY_FLAGS = new Set(['from', 'thread', 'message', 'body', 'ref', 'yes', 'dry-run', 'json', 'help']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BODY_MOST = 20000;
const READ_MS = 45000; // every inbox is read before the answer comes back
const SEND_MS = 60000;
const UNKNOWN = 'Gmail may have sent it. Check Sent in that inbox. Running this same command again will not send it twice.';

// Strip control characters so a stranger's subject cannot move the cursor or recolor the terminal.
const clean = (value) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
const when = (at) => clean(at).slice(0, 16).replace('T', ' ');
const inboxName = (a) => clean((a && (a.email || a.name)) || (a && a.account_id) || 'an inbox');
const quote = (text) => `"${String(text).replace(/(["\\$`])/g, '\\$1')}"`;

function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer || '').trim()));
    });
  });
}

/** The same inbox, thread, message and text always make the same ref. */
function replyRef(accountId, threadId, messageId, body) {
  const hash = crypto.createHash('sha256').update([accountId, threadId, messageId, body].join('\n')).digest('hex');
  return `cli-${hash.slice(0, 40)}`;
}

// Check the words before anything is sent. Returns { error } or { args }.
function prepare(sub, words, flags, rawArgs = []) {
  const name = words.slice(1).join(' ').trim();
  if (!name) return { error: `atris nexus ${sub} needs a name, like: atris nexus ${sub} "Rae Sample"` };
  if (sub === 'mail') return { args: { name } };

  const unknown = Object.keys(flags).filter((key) => !REPLY_FLAGS.has(key));
  if (unknown.length) return { error: `atris nexus reply does not take --${unknown[0]}, so nothing was sent. See: atris nexus --help` };
  // Only a bare --yes skips the question. --yes=no must not count as yes.
  const yes = rawArgs.some((arg) => String(arg) === '--yes');
  if (flags.yes && !yes) return { error: '--yes takes no value. Nothing was sent.' };
  if (flags['dry-run'] && !rawArgs.some((arg) => String(arg) === '--dry-run')) return { error: '--dry-run takes no value. Nothing was sent.' };

  const text = (key) => (typeof flags[key] === 'string' ? flags[key].trim() : '');
  const from = text('from');
  const message = text('message');
  const thread = text('thread');
  const ref = text('ref');
  const body = typeof flags.body === 'string' ? flags.body : '';
  const example = `atris nexus reply ${quote(name)} --from <inbox> --message <message id> --body "<text>"`;
  if (!from) return { error: `Name the inbox to reply from with --from (its email or account id). See them: atris nexus mail ${quote(name)}\n${example}` };
  if (!message) return { error: `Name the message you are answering with --message. See them: atris nexus mail ${quote(name)}\n${example}` };
  if (!SAFE_ID.test(message)) return { error: `"${clean(message)}" is not a message id. Copy it from atris nexus mail.` };
  if (thread && !SAFE_ID.test(thread)) return { error: `"${clean(thread)}" is not a thread id. Copy it from atris nexus mail.` };
  if (!body.trim()) return { error: `atris nexus reply needs the reply text in --body.\n${example}` };
  if (body.length > BODY_MOST) return { error: `Keep a reply under ${BODY_MOST} characters.` };
  if (ref.length > 128) return { error: 'Keep --ref under 128 characters.' };
  return { args: { name, from, message, thread, body, ref, yes, dryRun: !!flags['dry-run'] } };
}

function readError(result) {
  if (result.status === 402) return Object.assign(new Error(LOCKED_LINE), { status: 402 });
  if (result.status === 401) return new Error('Sign in to see your people. Run: atris login');
  if (result.status === 0 || result.status >= 500) return new Error('The people store did not answer. Try again in a moment.');
  return new Error(S.plainError(result));
}

// After a send was asked for: a 4xx means Gmail did not take it. Anything else may have gone out.
function sendError(result) {
  if (result.status === 402) return Object.assign(new Error(LOCKED_LINE), { status: 402 });
  if (result.status === 401) return new Error('Sign in again first: atris login. Nothing was sent.');
  const detail = result.data && result.data.detail;
  const said = typeof detail === 'string' || Array.isArray(detail) ? S.plainError(result) : '';
  if (result.status >= 400 && result.status < 500) {
    return new Error(/nothing was sent/i.test(said) ? said : `Not sent. ${said || `The people store answered ${result.status}.`}`);
  }
  if (result.status === 503 && /nothing was sent/i.test(said)) return new Error(said);
  return Object.assign(new Error(said && result.status !== 0 ? `${said} ${UNKNOWN}`.replace(/\s+/g, ' ') : UNKNOWN), { unknown: true });
}

/** The Gmail inbox --from names: its account id first, then its address. Never a guess. */
function findInbox(accounts, wanted) {
  const w = String(wanted || '').trim().toLowerCase();
  const gmail = (accounts || []).filter((a) => a && a.account_id);
  return gmail.find((a) => String(a.account_id).toLowerCase() === w)
    || gmail.find((a) => String(a.email || '').toLowerCase() === w)
    || null;
}

function mailLines(card, convo) {
  const lines = [];
  const email = clean(convo.email);
  lines.push(`${clean(card.name)}${email ? `, ${email}` : ''}`);
  const accounts = Array.isArray(convo.accounts) ? convo.accounts : [];
  if (!email) lines.push('This card has no email address, so no inbox was searched.');
  if (accounts.length) {
    lines.push('', 'Inboxes');
    for (const a of accounts) {
      const id = a.account_id ? `  (--from ${clean(a.account_id)})` : '';
      const state = { ok: '', reconnect: '  needs reconnecting', unavailable: '  did not answer', skipped: '  not searched' }[a.status] ?? `  ${clean(a.status)}`;
      const label = a.account_id ? inboxName(a) : `Atris mail${a.email ? `, ${clean(a.email)}` : ''}`;
      lines.push(`  ${label}${id}${state}`);
    }
  } else {
    lines.push('No Gmail inbox is connected. Connect one at atris.ai, then try again.');
  }
  const threads = Array.isArray(convo.threads) ? convo.threads : [];
  if (threads.length) {
    lines.push('', 'Threads you can reply in');
    for (const t of threads) {
      lines.push(`  ${when(t.last_at)}  ${clean(t.subject) || '(no subject)'}  ${t.count} ${t.count === 1 ? 'message' : 'messages'}, in ${clean(t.account_email || t.account_id)}`);
      lines.push(`    atris nexus reply ${quote(clean(card.name))} --from ${clean(t.account_id)} --message ${clean(t.reply_to_message_id)} --body "<text>"`);
    }
  }
  const messages = Array.isArray(convo.messages) ? convo.messages : [];
  lines.push('', messages.length ? 'Messages, newest first' : 'No mail with this person yet.');
  for (const m of messages) {
    const where = m.source === 'atris' ? 'Atris mail' : clean(m.account_email || m.account_id);
    lines.push(`  ${when(m.at)}  ${m.direction === 'outbound' ? 'sent' : 'got '}  ${where}  ${clean(m.subject) || '(no subject)'}`);
    const snippet = clean(m.snippet);
    if (snippet) lines.push(`    ${snippet}`);
    if (m.source === 'gmail') lines.push(`    --from ${clean(m.account_id)} --message ${clean(m.message_id)}`);
  }
  return lines;
}

async function run(ctx) {
  const { sub, json, log, fail, usage } = ctx;
  const prep = prepare(sub, ctx.words, ctx.flags, ctx.rawArgs || []);
  if (prep.error) return usage(prep.error);
  const args = prep.args;
  const request = ctx.request;
  const out = (data) => log(JSON.stringify(data));

  try {
    const found = await request('/nexus/people/search', { token: ctx.token, method: 'POST', body: { q: args.name, limit: 200 }, timeoutMs: 15000, retries: 0 });
    if (!found.ok) throw readError(found);
    const cards = Array.isArray(found.data && found.data.people) ? found.data.people : [];
    const picked = ctx.pick({ rows: cards.map((card) => ({ name: String(card.name || ''), card })) }, args.name);
    if (picked.stop !== undefined) return picked.stop;
    const card = picked.row.card;
    const base = `/nexus/people/${encodeURIComponent(card.id)}`;

    const listed = await request(`${base}/conversations`, { token: ctx.token, method: 'GET', timeoutMs: READ_MS });
    if (!listed.ok) throw readError(listed);
    const convo = listed.data && typeof listed.data === 'object' ? listed.data : {};

    if (sub === 'mail') {
      if (json) out({ ok: true, id: card.id, name: card.name, ...convo });
      else for (const line of mailLines(card, convo)) log(line);
      return 0;
    }

    // reply: the named inbox, the named message, checked against what the store just showed.
    const accounts = Array.isArray(convo.accounts) ? convo.accounts : [];
    const inbox = findInbox(accounts, args.from);
    if (!inbox) {
      const names = accounts.filter((a) => a.account_id).map((a) => `${inboxName(a)} (--from ${clean(a.account_id)})`);
      return fail(`No connected Gmail inbox matches "${clean(args.from)}". Nothing was sent.${names.length ? ` Yours: ${names.join(', ')}` : ' Connect one at atris.ai first.'}`);
    }
    if (inbox.status && inbox.status !== 'ok') {
      return fail(`${inboxName(inbox)} ${inbox.status === 'reconnect' ? 'needs reconnecting at atris.ai' : 'did not answer just now'}. Nothing was sent.`);
    }
    const messages = Array.isArray(convo.messages) ? convo.messages : [];
    const gmail = messages.filter((m) => m && m.source === 'gmail');
    const here = gmail.find((m) => m.account_id === inbox.account_id && m.message_id === args.message);
    const elsewhere = here ? null : gmail.find((m) => m.message_id === args.message);
    if (elsewhere) {
      return fail(`That message is in ${clean(elsewhere.account_email || elsewhere.account_id)}, not ${inboxName(inbox)}. Nothing was sent. Reply from the inbox that got it: --from ${clean(elsewhere.account_id)}`);
    }
    if (!here && !args.thread) {
      return fail(`That message is not among the newest mail with ${clean(card.name)} in ${inboxName(inbox)}. Nothing was sent. For an older message add --thread with its thread id.`);
    }
    if (here && args.thread && args.thread !== here.thread_id) {
      return fail(`That message is in thread ${clean(here.thread_id)}, not ${clean(args.thread)}. Nothing was sent.`);
    }
    const threadId = here ? here.thread_id : args.thread;
    const subject = here ? clean(here.subject) : '';
    const reply = {
      ref: args.ref || replyRef(inbox.account_id, threadId, args.message, args.body),
      account_id: inbox.account_id,
      thread_id: threadId,
      message_id: args.message,
      body: args.body,
    };
    const preview = [
      `From:    ${inboxName(inbox)}`,
      `To:      ${clean(convo.email) || '(this card has no email)'}`,
      `Subject: ${subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : '(the thread\'s own subject)'}`,
      `Answers: message ${clean(args.message)} in thread ${clean(threadId)}`,
      '',
      args.body,
      '',
    ].join('\n');

    if (args.dryRun) {
      if (json) out({ ok: true, dry_run: true, sent: false, id: card.id, name: card.name, account_email: inbox.email || null, to: convo.email || null, ...reply });
      else log(`${preview}\nDry run: nothing was sent.`);
      return 0;
    }
    if (!args.yes) {
      if (json) return fail('Not sent. Add --yes to send without asking, or --dry-run to see it first.', { sent: false });
      log(preview);
      const ok = await (ctx.confirm || askYesNo)('Send this reply? (y/N) ');
      if (!ok) {
        log(process.stdin.isTTY || ctx.confirm ? 'Not sent.' : 'Not sent. Add --yes to send without asking.');
        return 1;
      }
    }

    const sent = await request(`${base}/reply`, { token: ctx.token, method: 'POST', body: reply, retries: 0, timeoutMs: SEND_MS });
    if (!sent.ok) {
      const error = sendError(sent);
      return fail(error.message, { sent: error.unknown ? null : false, ...(error.status ? { status: error.status } : {}) });
    }
    const data = sent.data && typeof sent.data === 'object' ? sent.data : {};
    if (data.replayed) {
      if (json) out({ ok: true, replayed: true, sent: null, id: card.id, name: card.name, account_id: inbox.account_id, ref: reply.ref });
      else log(`This reply was already sent with this ref, so nothing new went out. Check Sent in ${inboxName(inbox)}.`);
      return 0;
    }
    if (json) out({ ok: true, replayed: false, id: card.id, name: card.name, ref: reply.ref, ...data });
    else log(`Sent from ${clean(data.account_email) || inboxName(inbox)} to ${clean(card.name)}, in the thread${data.subject ? ` ${quote(clean(data.subject))}` : ''}.`);
    return 0;
  } catch (error) {
    return fail(error && error.message, error && error.status ? { status: error.status } : {});
  }
}

module.exports = { SUBS, prepare, run, findInbox, replyRef, mailLines };
