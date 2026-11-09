'use strict';

const os = require('os');
const path = require('path');
const { apiRequestJson } = require('../utils/api');
const { ensureFreshCredentials } = require('../utils/auth');
const { dangerousWorkspaceReason } = require('../lib/workspace-safety');
const { NOT_LOGGED_IN, tokenFrom, oneLine } = require('../lib/developer-api');
const {
  isRemovable,
  isWritable,
  memoryClient,
  pullFolder,
  pushFolder,
  statusFolder,
} = require('../lib/memory-folder');
const { LIVE_HELP, isLiveCommand } = require('../lib/memory-live');

const USAGE = [
  ...LIVE_HELP,
  'copy to laptop: atris memory <pull|push|status> [folder] [--json]',
  '  pull    copy your Atris memory folder down (default: ~/atris-memory)',
  '  push    send back changes under wiki/ and files/',
  '          --prune also removes pages under wiki/ and files/ that you deleted here',
  '  status  show what changed here since the last pull',
].join('\n');

function resolveDir(arg) {
  const home = os.homedir();
  let raw = arg || path.join(home, 'atris-memory');
  if (raw === '~') raw = home;
  else if (raw.startsWith('~/')) raw = path.join(home, raw.slice(2));
  const abs = path.resolve(raw);
  const reason = dangerousWorkspaceReason(abs);
  if (reason) throw new Error(`${abs} is ${reason}. Pick a dedicated folder, like ~/atris-memory.`);
  return abs;
}

function shortPath(abs) {
  const home = os.homedir();
  return abs === home || abs.startsWith(home + path.sep) ? `~${abs.slice(home.length)}` : abs;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function nameList(list, max = 4) {
  const names = list.map((item) => (typeof item === 'string' ? item : item.path));
  return names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', ');
}

function pullLines(dir, r) {
  const lines = [`Pulled ${plural(r.total, 'file', 'files')} into ${shortPath(dir)}.`];
  const parts = [];
  if (r.added.length) parts.push(`${r.added.length} new`);
  if (r.updated.length) parts.push(`${r.updated.length} updated`);
  if (r.same) parts.push(`${r.same} already current`);
  if (parts.length) lines.push(`${parts.join(', ')}.`);
  if (r.keptLocal.length) lines.push(`Kept your edits to ${nameList(r.keptLocal)}. The server copy has not changed.`);
  if (r.conflicts.length) {
    lines.push(`Left ${nameList(r.conflicts)} alone: it changed here and on the server. To take the server copy, move yours aside and pull again.`);
  }
  if (r.unsafe.length) lines.push(`Skipped ${plural(r.unsafe.length, 'file', 'files')} with names that are not safe to copy.`);
  if (r.gone) lines.push(`${plural(r.gone, 'file is', 'files are')} no longer on the server. Your copies are untouched.`);
  for (const f of r.failed.slice(0, 3)) lines.push(`Could not copy ${f.path}: ${oneLine(f.error)}`);
  if (r.failed.length > 3) lines.push(`${r.failed.length - 3} more could not be copied.`);
  if (r.usedLineFallback) lines.push('The server is on its older download, so line endings may be tidied.');
  return lines;
}

function pushLines(r) {
  const lines = [];
  if (r.pushed.length) lines.push(`Pushed ${plural(r.pushed.length, 'file', 'files')}: ${nameList(r.pushed)}.`);
  if (r.alreadyThere.length) lines.push(`Already on the server: ${nameList(r.alreadyThere)}.`);
  if (r.notPushable.length) {
    lines.push(`Not pushed: ${nameList(r.notPushable)}. Those change through remember (the Atris connection's remember tool), not by file write.`);
  }
  if (r.conflicts.length) {
    lines.push(`Not pushed: ${nameList(r.conflicts)} changed on the server since your last pull, so nothing was overwritten. Run: atris memory pull`);
  }
  if (r.tooBig.length) lines.push(`Not pushed: ${nameList(r.tooBig)} is over 1 MB.`);
  if (r.notText.length) lines.push(`Not pushed: ${nameList(r.notText)} is not a text file.`);
  for (const f of r.failed.slice(0, 3)) lines.push(`Could not ${f.removing ? 'remove' : 'push'} ${f.path}: ${oneLine(f.error)}`);
  lines.push(...deleteLines(r));
  if (r.skipped.length) lines.push(`Skipped ${nameList(r.skipped.map((s) => `${s.path} (${s.reason})`))}.`);
  if (!lines.length) lines.push('Nothing to push. Nothing changed since your last pull.');
  return lines;
}

const PRUNE_HINT = 'atris memory push --prune';

function deleteLines(r) {
  const lines = [];
  if (r.pruned) {
    if (r.removed.length) lines.push(`Removed ${plural(r.removed.length, 'file', 'files')} from your Atris memory: ${nameList(r.removed)}.`);
    if (r.alreadyGone.length) lines.push(`Already gone from your Atris memory: ${nameList(r.alreadyGone)}.`);
    if (r.changedOnServer.length) {
      lines.push(`Not removed: ${nameList(r.changedOnServer)} changed on the server since your last pull, so nothing was lost. Run: atris memory pull`);
    }
    if (r.notRemovable.length) lines.push(`Not removed: ${nameList(r.notRemovable)}. Notes and daily pages can't be deleted; pull brings them back.`);
    return lines;
  }
  const removable = r.deletedHere.filter(isRemovable);
  const kept = r.deletedHere.filter((rel) => !isRemovable(rel));
  if (removable.length) {
    lines.push(`${plural(removable.length, 'file was', 'files were')} deleted here (${nameList(removable)}) and ${removable.length === 1 ? 'is' : 'are'} still in your Atris memory. To remove ${removable.length === 1 ? 'it' : 'them'} there too, run: ${PRUNE_HINT}`);
  }
  if (kept.length) lines.push(`${nameList(kept)} ${kept.length === 1 ? 'was' : 'were'} deleted here. Notes and daily pages can't be deleted; pull brings them back.`);
  return lines;
}

function pruneNotice(log) {
  return (doomed) => {
    log(`Removing ${plural(doomed.length, 'file', 'files')} from your Atris memory, because you deleted ${doomed.length === 1 ? 'it' : 'them'} here:`);
    for (const rel of doomed) log(`  ${rel}`);
  };
}

function statusLines(r) {
  const rows = [
    ...r.modified.map((rel) => ['edited', rel]),
    ...r.added.map((rel) => ['new', rel]),
    ...r.deleted.map((rel) => ['deleted', rel]),
  ];
  const when = r.pulledAt ? ` (last pull ${r.pulledAt})` : '';
  if (!rows.length) return [`Nothing changed here since your last pull${when}.`];
  const lines = [`Changed here since your last pull${when}:`];
  for (const [kind, rel] of rows) {
    const note = kind === 'deleted'
      ? (isRemovable(rel) ? `  (${PRUNE_HINT} removes it from Atris)` : '  (notes and daily pages stay; pull brings it back)')
      : isWritable(rel) ? '' : '  (changes through remember, not pushed)';
    lines.push(`  ${kind.padEnd(8)} ${rel}${note}`);
  }
  for (const s of r.skipped) lines.push(`  skipped  ${s.path} (${s.reason})`);
  return lines;
}

async function defaultToken() {
  const creds = await ensureFreshCredentials(apiRequestJson);
  return { token: tokenFrom(creds), account: (creds && creds.user_id) || null };
}

async function memoryCommand(args = [], deps = {}) {
  const log = deps.log || console.log;
  const err = deps.err || console.error;
  const json = args.includes('--json');
  const prune = args.includes('--prune');
  const words = args.filter((arg) => !arg.startsWith('-'));
  const [sub, folderArg] = words;
  if (isLiveCommand(sub)) return require('./memory-live').memoryLiveCommand(args, deps);
  const help = args.includes('--help') || args.includes('-h') || sub === 'help' || !sub;
  if (help) {
    log(USAGE);
    return 0;
  }
  if (!['pull', 'push', 'status'].includes(sub)) {
    err(`atris memory: unknown command "${sub}"\n${USAGE}`);
    return 2;
  }
  if (prune && sub !== 'push') {
    err(`atris memory: --prune only works with push\n${USAGE}`);
    return 2;
  }

  const fail = (message) => {
    if (json) log(JSON.stringify({ ok: false, error: oneLine(message) }));
    else err(oneLine(message));
    return 1;
  };

  try {
    const dir = resolveDir(folderArg);
    let result;
    let lines;
    let code = 0;
    if (sub === 'status') {
      result = statusFolder({ dir });
      lines = statusLines(result);
    } else {
      const { token, account } = await (deps.getToken || defaultToken)();
      if (!token) return fail(NOT_LOGGED_IN);
      const client = memoryClient(deps.apiRequestJson || apiRequestJson, token);
      if (sub === 'pull') {
        result = await pullFolder({ dir, client, account });
        lines = pullLines(dir, result);
        code = result.failed.length ? 1 : 0;
      } else {
        result = await pushFolder({ dir, client, account, prune, onPrune: json ? null : pruneNotice(log) });
        lines = pushLines(result);
        code = result.failed.length || result.conflicts.length || (result.changedOnServer || []).length ? 1 : 0;
      }
    }
    if (json) log(JSON.stringify({ ok: code === 0, dir, ...result }));
    else for (const line of lines) log(line);
    return code;
  } catch (error) {
    return fail(error && error.message);
  }
}

module.exports = { memoryCommand };
