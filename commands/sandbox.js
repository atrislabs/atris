'use strict';

const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, wantsHelp, wantsJson, tokenFrom, oneLine, printResult } = require('../lib/developer-api');

function showSandboxHelp(log = console.log) {
  log('usage: atris sandbox [list|look <name>|guide|mine] [--json]');
  log('       atris sandbox open "<title>" --brief "<what you want built>" [--who anyone|sponsored|aligned] [--kinds thing,note] [--each <1-20>] [--unlisted]');
  log('       atris sandbox add <name> --note "<words>"');
  log('       atris sandbox add <name> --thing <thing> [--style <kind>] [--colour <name>] [--text "<words>"] [--small "<words>"] [--count <n>]');
  log('       atris sandbox waiting <name>');
  log('       atris sandbox accept|decline|ban|remove <name> <id>');
  log('       atris sandbox pause|resume|close <name>');
  log('list open sandboxes, open one, or add to someone else\'s. every form takes --json and --help.');
}

const clean = (value) => oneLine(String(value == null ? '' : value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
const nameOk = (s) => typeof s === 'string' && s.length >= 3 && s.length <= 30 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
const idOk = (s) => typeof s === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(s);

function parse(args) {
  const words = [], flags = {};
  const valueFlags = ['brief', 'who', 'kinds', 'each', 'note', 'thing', 'style', 'colour', 'text', 'small', 'count'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') continue;
    if (arg === '--unlisted') { if (flags.unlisted) return null; flags.unlisted = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!valueFlags.includes(key) || flags[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) return null;
      flags[key] = args[++i];
    } else words.push(arg);
  }
  const action = words.shift() || 'list';
  const spec = {
    list: [0, []], guide: [0, []], mine: [0, []], look: [1, []], waiting: [1, []],
    open: [1, ['brief', 'who', 'kinds', 'each', 'unlisted']],
    add: [1, ['note', 'thing', 'style', 'colour', 'text', 'small', 'count']],
    accept: [2, []], decline: [2, []], ban: [2, []], remove: [2, []],
    pause: [1, []], resume: [1, []], close: [1, []],
  }[action];
  if (!spec || words.length !== spec[0] || Object.keys(flags).some((f) => !spec[1].includes(f))) return null;
  if (action !== 'open' && spec[0] && !nameOk(words[0])) return null;
  if (spec[0] === 2 && !idOk(words[1])) return null;
  if (action === 'open' && (!words[0].trim() || !flags.brief || !flags.brief.trim() || (flags.who && !['anyone', 'sponsored', 'aligned'].includes(flags.who)) || (flags.kinds && flags.kinds.split(',').some((k) => !['thing', 'note'].includes(k))) || (flags.each && (!/^\d+$/.test(flags.each) || +flags.each < 1 || +flags.each > 20)))) return null;
  if (action === 'add' && (Boolean(flags.note) === Boolean(flags.thing) || (flags.note && ['style', 'colour', 'text', 'small', 'count'].some((k) => flags[k] !== undefined)) || (flags.count && (!/^\d+$/.test(flags.count) || +flags.count < 1)))) return null;
  return { action, words, flags };
}

function contribution(c) {
  const thing = c.thing || {};
  const content = c.kind === 'note' ? c.text : [thing.kind, thing.type, thing.text && `"${thing.text}"`].filter(Boolean).join(' ');
  return `  ${clean(c.kind)}  ${clean(content)}${c.name ? `, ${clean(c.name)}` : ''}${c.by ? `  by ${clean(c.by)}` : ''}`;
}

function render(action, data, text) {
  if (action === 'guide') return String(text == null ? '' : text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  const lines = [];
  const sandboxes = Array.isArray(data.sandboxes) ? data.sandboxes : [];
  const contributions = Array.isArray(data.contributions) ? data.contributions : [];
  const row = (s) => `${clean(s.slug)}   ${clean(s.title)}${s.owner ? `   by ${clean(s.owner)}` : ''}   ${clean(s.count)} in   ${s.open ? 'open' : 'paused'}${s.waiting != null ? `   ${clean(s.waiting)} waiting` : ''}\n  ${clean(s.brief)}`;
  if (action === 'list' || action === 'mine') {
    if (sandboxes.length) lines.push(...sandboxes.map(row));
    else lines.push('no sandboxes yet. next: atris sandbox open "<title>" --brief "<what you want>"');
    if (action === 'mine' && contributions.length) lines.push(...contributions.map((c) => `  ${clean(c.sandbox)}  ${clean(c.kind)}  ${clean(c.status)}  ${clean(c.id)}  ${clean(c.at)}`));
  } else if (action === 'look') {
    const s = data.sandbox || {};
    lines.push(`${clean(s.title)} (${clean(s.slug)})${s.owner ? `, by ${clean(s.owner)}` : ''}, ${s.open ? 'open' : 'paused'}`, clean(s.brief));
    lines.push(`rules: ${clean(s.who)} can add; ${Array.isArray(s.kinds) ? s.kinds.map(clean).join(' and ') : 'things and notes'}; up to ${clean(s.each)} each; the owner looks at everything first`);
    lines.push(`${clean(s.count)} in, ${clean(s.free)} free`);
    if (contributions.length) lines.push(...contributions.map(contribution));
    else lines.push('nothing here yet.');
  } else if (action === 'waiting') {
    lines.push(...(contributions.length ? contributions.map(contribution) : ['nothing is waiting.']));
  } else if (action === 'add') {
    lines.push(`added. ${data.status === 'pending' ? 'it waits for the owner.' : 'it is live.'} id ${clean(data.id)}`);
  } else if (action === 'open' || action === 'pause' || action === 'resume') {
    const s = data.sandbox || {};
    lines.push(`${clean(s.title)} (${clean(s.slug)}) ${s.open ? 'open' : 'paused'}.`);
  } else lines.push(`${clean(data.id || data.slug)} ${clean(data.status)}.`);
  if (data.caution) lines.push(clean(data.caution));
  if (data.next) lines.push(`next: ${clean(data.next)}`);
  return lines.join('\n');
}

async function sandboxCommand(args = [], deps = {}) {
  const io = { log: deps.log || console.log, err: deps.err || console.error };
  if (wantsHelp(args)) { showSandboxHelp(io.log); return 0; }
  const json = wantsJson(args);
  const fail = (error, status) => {
    const payload = { ok: false, error };
    if (status !== undefined) payload.status = status;
    printResult({ json, ok: false, error, payload }, io);
    return 1;
  };
  const parsed = parse(args);
  if (!parsed) return fail('give a valid sandbox command and its required values. run: atris sandbox --help');
  const { action, words, flags } = parsed;
  const request = deps.apiRequestJson || apiRequestJson;
  try {
    const token = tokenFrom(await (deps.loadCredentials || loadCredentials)(request));
    if (!token && !['list', 'look', 'guide'].includes(action)) return fail(NOT_LOGGED_IN);
    let path = '/world/sandboxes', method = 'GET', body;
    if (['guide', 'mine'].includes(action)) path += `/${action}`;
    else if (!['list', 'open'].includes(action)) path += `/${encodeURIComponent(words[0])}`;
    if (action === 'open') {
      method = 'POST'; body = { title: words[0], brief: flags.brief };
      if (flags.who) body.who = flags.who;
      if (flags.kinds) body.kinds = flags.kinds.split(',');
      if (flags.each) body.each = Number(flags.each);
      if (flags.unlisted) body.listed = false;
    } else if (action === 'add') {
      method = 'POST'; path += '/contributions';
      body = flags.note ? { kind: 'note', text: flags.note } : { kind: 'thing', thing: flags.thing };
      for (const key of ['style', 'colour', 'text', 'small', 'count']) if (flags[key] !== undefined) body[key] = key === 'count' ? Number(flags[key]) : flags[key];
    } else if (action === 'waiting') path += '/waiting';
    else if (['accept', 'decline', 'ban'].includes(action)) { method = 'POST'; path += `/contributions/${encodeURIComponent(words[1])}/review`; body = { decision: action }; }
    else if (action === 'remove') { method = 'DELETE'; path += `/contributions/${encodeURIComponent(words[1])}`; }
    else if (['pause', 'resume'].includes(action)) { method = 'PATCH'; body = { open: action === 'resume' }; }
    else if (action === 'close') method = 'DELETE';
    const options = { method, token };
    if (method !== 'GET') options.retries = 0;
    if (body !== undefined) options.body = body;
    const result = await request(path, options);
    if (!result || !result.ok) {
      const error = action === 'list' && result && result.status === 404 ? 'sandboxes are rolling out, try again shortly' : clean(result && result.data && typeof result.data.detail === 'string' ? result.data.detail : result && result.error);
      return fail(error, result && result.status);
    }
    const data = action === 'guide' ? { guide: render(action, {}, result.text) } : result.data || {};
    printResult({ json, ok: true, text: action === 'guide' ? data.guide : render(action, data), payload: { ok: true, ...data } }, io);
    return 0;
  } catch (error) { return fail(clean(error && error.message)); }
}

module.exports = { sandboxCommand, showSandboxHelp };
