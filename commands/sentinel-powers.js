'use strict';

// The free sentinel commands: agents, guard, watch and flush. Each reports
// to the dashboard through POST /api/sentinel/events (lib/sentinel-events.js).
//
//   atris sentinel agents [path] [--home]        check an agent setup
//   atris sentinel guard install|uninstall|status|test [--global]
//   atris sentinel watch [path] [--fix] [--allow-major]  known attacks in dependencies
//   atris sentinel flush                         send queued guard events
//
// An upload problem is a warning line. It never changes the exit code.

const fs = require('fs');
const path = require('path');

function tildePath(p, home = require('os').homedir()) {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function parseFlags(argv, known) {
  const opts = { paths: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!known.includes(name)) throw new Error(`unknown flag: ${a}`);
      opts[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    } else if (a.startsWith('-') && a !== '-') {
      throw new Error(`unknown flag: ${a}`);
    } else opts.paths.push(a);
  }
  return opts;
}

function resolveRoot(opts, deps) {
  const root = path.resolve(opts.paths[0] || deps.root || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
  return root;
}

function tokenFor(deps) {
  if (deps.token !== undefined) return deps.token;
  return require('../lib/sentinel-cloud').authToken();
}

function uploadLine(res, what) {
  if (res.skipped === 'no-upload') return '  kept on this machine. nothing was sent (--no-upload)';
  if (res.skipped === 'not-logged-in') return '  not logged in. nothing was sent. run atris login to see this on your dashboard';
  if (!res.ok) return `  warning: could not send ${what} to your atris dashboard: ${res.reason}. the check itself is done`;
  const resolved = res.resolved ? ` and marked ${res.resolved} as fixed` : '';
  return `  sent ${res.sent - (res.resolved || 0)} ${what} to your atris dashboard${resolved}. no file contents or secret values were sent`;
}

// ---------------------------------------------------------------- update

// A stale global install misses sentinel fixes. Every sentinel command
// ends with one line when npm has a newer atris. The check starts with the
// command and gets a short wait at the end. It never blocks or fails a run.
function startUpdateNotice(argv = [], { env = process.env, check, timeoutMs = 1500, packageRoot = path.join(__dirname, '..') } = {}) {
  const off = env.ATRIS_SKIP_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER
    || argv.some((a) => ['--json', '--help', '-h', 'help', '--quiet'].includes(a));
  if (off) return { print: async () => null };
  const updates = require('../utils/update-check');
  let pending;
  try { pending = Promise.resolve((check || updates.checkForUpdates)()).catch(() => null); } catch { pending = Promise.resolve(null); }
  return {
    async print(log = console.log) {
      let timer;
      const late = new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); if (timer.unref) timer.unref(); });
      const info = await Promise.race([pending, late]);
      clearTimeout(timer);
      if (!info || !info.needsUpdate) return null;
      let how = 'npm install -g atris@latest';
      try { if (updates.isGitCheckout(packageRoot)) how = 'atris upgrade'; } catch {}
      const line = `  a newer atris is out: ${info.latest}. this one is ${info.installed}. update with: ${how}`;
      log(line);
      return line;
    },
  };
}

// ---------------------------------------------------------------- agents

async function runAgents(root, { home = false, upload = true, deps = {} } = {}) {
  const agents = require('../lib/sentinel-agents');
  const events = require('../lib/sentinel-events');
  const homeDir = deps.homeDir || process.env.HOME || require('os').homedir();
  const result = agents.runAgentCheck(root, { home, homeDir });
  const evs = agents.toEvents(result, { repo: deps.repo });
  let res;
  try {
    res = await events.reportFindings(root, 'agent_check', evs, { token: upload ? tokenFor(deps) : '', base: deps.base, env: deps.env || process.env, upload });
  } catch (e) { res = { ok: false, reason: e.message }; }
  return { result, events: evs, upload: res };
}

async function agentsCommand(argv, deps = {}) {
  let opts;
  try { opts = parseFlags(argv, ['home', 'json', 'no-upload']); } catch (e) { console.error(`  ${e.message}`); return 2; }
  let root;
  try { root = resolveRoot(opts, deps); } catch (e) { console.error(`  ${e.message}`); return 2; }
  const { result, upload } = await runAgents(root, { home: Boolean(opts.home), upload: !opts.noUpload, deps });
  if (opts.json) {
    console.log(JSON.stringify({ ok: result.grade !== 'fail', grade: result.grade, areas: result.areas, files: result.files, findings: result.findings, upload }, null, 2));
  } else {
    console.log(require('../lib/sentinel-agents').renderReport(result));
    console.log(uploadLine(upload, 'the findings'));
    console.log('');
  }
  return result.grade === 'fail' ? 1 : 0;
}

// ---------------------------------------------------------------- watch

// A threat that is gone here counts as fixed only on the repo's default
// branch, or when the default branch no longer holds the affected version.
// On a side branch it stays open on the dashboard.
function holdForBranch(branch) {
  if (!branch || branch.onDefault) return null;
  const live = branch.liveFingerprints;
  if (!live) return () => true;
  return (fp) => live.has(fp);
}

async function runWatchCheck(root, { upload = true, deps = {} } = {}) {
  const watch = require('../lib/sentinel-watch');
  const events = require('../lib/sentinel-events');
  const result = await watch.runWatch(root, { base: deps.osvBase || process.env.ATRIS_OSV_BASE || watch.OSV_BASE, ...(deps.request ? { request: deps.request } : {}), ...(deps.maxLockfileBytes ? { maxBytes: deps.maxLockfileBytes } : {}) });
  const evs = watch.toEvents(result, { repo: deps.repo });
  let branch = null;
  try { branch = watch.branchState(root, { run: deps.run }); } catch { branch = { git: true, onDefault: false, liveFingerprints: null }; }
  let res;
  if (result.offline) res = { ok: true, skipped: 'offline', sent: 0 };
  else {
    try {
      // Per lockfile: an earlier threat is fixed only when every lockfile it
      // was found in was read this time and none of them holds it now. One
      // whose lockfile was not read (depth, cap, size, error, moved or
      // deleted) stays open. An old record with no lockfile list needs a
      // complete scan.
      const read = new Set(result.lockfiles.map((l) => l.file));
      const branchHold = holdForBranch(branch);
      const why = { unread: 0, branch: 0 };
      // Locations not read this run are kept by reportFindings itself. Here:
      // an old record with no lockfile list plus the branch rule.
      const hold = (fp, prev) => {
        const lfs = prev && Array.isArray(prev.lockfiles) && prev.lockfiles.length ? prev.lockfiles : null;
        if (!lfs && result.incomplete) { why.unread += 1; return true; }
        if (branchHold && branchHold(fp)) { why.branch += 1; return true; }
        return false;
      };
      res = await events.reportFindings(root, 'threat', evs, { token: upload ? tokenFor(deps) : '', base: deps.base, env: deps.env || process.env, upload, hold, meta: watch.lockfilesByFingerprint(result), read });
      res.heldUnread = why.unread + (res.heldLocations || 0);
      res.heldBranch = why.branch;
    } catch (e) { res = { ok: false, reason: e.message }; }
  }
  return { result, events: evs, upload: res, branch };
}

function heldLines(upload, branch) {
  const L = [];
  const u = (upload && upload.heldUnread) || 0;
  const b = (upload && upload.heldBranch) || 0;
  if (u) L.push(`  ${u} earlier threat${u === 1 ? ' was' : 's were'} in a lockfile this check did not read. ${u === 1 ? 'it stays' : 'they stay'} open on your dashboard`);
  if (b) {
    const target = (branch && branch.defaultBranch) || 'the default branch';
    L.push(`  fixed on this branch, not yet live: ${b} threat${b === 1 ? '' : 's'}. ${b === 1 ? 'it stays' : 'they stay'} open on your dashboard until the fix is merged into ${target}`);
  }
  return L;
}

// One or two lines per package left for a person. Never cut short.
function manualLines(manual) {
  const L = [];
  if (!manual || !manual.length) return L;
  L.push(`  left for you to update (${manual.length}):`);
  for (const a of manual) {
    const to = a.fixed ? ` to ${a.fixed}` : '';
    L.push(`    ${a.name} ${a.version}${to} in ${a.lockfile || a.ecosystem}: ${a.why || 'not updated'}`);
  }
  return L;
}

async function watchCommand(argv, deps = {}) {
  let opts;
  try { opts = parseFlags(argv, ['fix', 'json', 'no-upload', 'allow-major']); } catch (e) { console.error(`  ${e.message}`); return 2; }
  let root;
  try { root = resolveRoot(opts, deps); } catch (e) { console.error(`  ${e.message}`); return 2; }
  const watch = require('../lib/sentinel-watch');
  const { result, upload, branch } = await runWatchCheck(root, { upload: !opts.noUpload, deps });
  let fix = null;
  if (opts.fix && !result.offline && result.affected.length) {
    try { fix = watch.applyFix(root, result, { run: deps.run, allowMajor: Boolean(opts.allowMajor) }); } catch (e) { fix = { ok: false, reason: String(e.message || e).split('\n')[0] }; }
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: !result.affected.some((a) => a.severity === 'critical' || a.severity === 'high'), ...result, upload, branch: branch ? { ...branch, liveFingerprints: undefined } : null, fix }, null, 2));
  } else {
    console.log(watch.renderReport(result));
    if (upload.skipped !== 'offline') console.log(uploadLine(upload, 'the threats'));
    for (const l of heldLines(upload, branch)) console.log(l);
    if (fix) {
      console.log('');
      if (!fix.ok) console.log(`  the fix did not run: ${fix.reason}`);
      else if (!fix.branch) console.log(`  the fix changed nothing${fix.message ? `: ${fix.message}` : ''}`);
      else {
        console.log(`  updated ${fix.changed} file${fix.changed === 1 ? '' : 's'} on a new branch: ${fix.branch}`);
        console.log(`  review it with: git diff ${fix.from || 'main'}...${fix.branch}`);
        console.log(`  go back with: git checkout ${fix.from || 'main'}`);
        console.log('  nothing was pushed');
      }
      for (const te of fix.toolErrors || []) {
        console.log(`  ${te.tool} could not update ${te.lockfile}. it said:`);
        for (const l of te.lines) console.log(`    ${l}`);
        if (te.hint) console.log(`  ${te.hint}`);
      }
      for (const l of manualLines(fix.manual)) console.log(l);
    }
    console.log('');
  }
  if (fix && !fix.ok) return 1;
  return result.affected.some((a) => a.severity === 'critical' || a.severity === 'high') ? 1 : 0;
}

// ---------------------------------------------------------------- guard

function guardHelp() {
  console.log(`
  atris sentinel guard, an action guard for coding agents

    atris sentinel guard install            guard claude code in this project
    atris sentinel guard install --global   guard every claude code session on this computer
    atris sentinel guard status [--global]  is it on and what it stopped today
    atris sentinel guard test               run sample commands through the rules
    atris sentinel guard uninstall [--global]

  it stops shell commands that send secrets out, delete home or root, force
  push to main, drop databases or turn off security. normal curl, git push
  and rm in project folders still run. it uses fixed rules and no model.
  trusted sites for secrets can be added in ~/.atris/sentinel/guard.json.

  what it promises: it stops the common ways an agent leaks a key or runs a
  destructive command. a network call that carries a secret runs only through
  curl, wget or httpie with options on a short safe list, to trusted sites. a
  command that names claude settings or the guard's files runs only when it
  is a read-only program like cat, grep or git log. what it cannot promise: a program that hides its
  intent can still get past fixed rules. it does not read encoded payloads
  or scripts written to disk and then run. it does not read interpreters
  like python -c either. it is a seatbelt, not a sandbox.
`);
  return 0;
}

async function guardCommand(argv, deps = {}) {
  const sub = argv[0] || 'status';
  const rest = argv.slice(1);
  if (sub === 'help' || argv.includes('--help') || argv.includes('-h')) return guardHelp();
  let opts;
  try { opts = parseFlags(rest, ['global', 'json']); } catch (e) { console.error(`  ${e.message}`); return 2; }
  const inst = require('../lib/sentinel-guard-install');
  const env = deps.env || process.env;
  const root = deps.root || process.cwd();
  const where = opts.global ? 'every claude code session on this computer' : `claude code in ${tildePath(path.resolve(root), env.HOME || undefined)}`;
  if (sub === 'install') {
    let st;
    try { st = inst.install({ global: Boolean(opts.global), root, env, atrisBin: deps.atrisBin }); } catch (e) { console.error(`  could not install the guard: ${e.message}. your settings were not changed`); return 1; }
    console.log(`\n  the sentinel guard is on for ${where}`);
    console.log(`  settings: ${tildePath(st.settings, env.HOME || undefined)}`);
    console.log('  it checks each shell command and file edit before it runs. try it with atris sentinel guard test');
    if (st.hooks_off) console.log('  warning: these settings turn all hooks off. the guard will not run until that is removed');
    console.log('  it starts with the next claude code session\n');
    return 0;
  }
  if (sub === 'uninstall') {
    try { inst.uninstall({ global: Boolean(opts.global), root, env }); } catch (e) { console.error(`  could not remove the guard: ${e.message}. your settings were not changed`); return 1; }
    console.log(`  the sentinel guard is off for ${where}`);
    return 0;
  }
  if (sub === 'status') {
    const st = inst.status({ global: Boolean(opts.global), root, env });
    const blocks = inst.recentBlocks({ env });
    const events = require('../lib/sentinel-events');
    const waiting = events.queueSize(env);
    if (opts.json) { console.log(JSON.stringify({ ...st, blocked_today: blocks.length, waiting_to_send: waiting }, null, 2)); return 0; }
    console.log('');
    if (st.installed) console.log(`  the sentinel guard is on for ${where}`);
    else if (!st.readable) console.log(`  could not read ${tildePath(st.settings, env.HOME || undefined)}. the guard state is unknown`);
    else console.log(`  the sentinel guard is off for ${where}. turn it on with atris sentinel guard install${opts.global ? ' --global' : ''}`);
    if (st.installed && !st.current) console.log('  the installed copy is older than this atris. run install again to update it');
    if (st.hooks_off) console.log('  warning: these settings turn all hooks off. the guard does not run');
    console.log(`  stopped ${blocks.length} action${blocks.length === 1 ? '' : 's'} in the last day${blocks.length ? `. latest: ${blocks[blocks.length - 1].reason.replace(/^blocked: /, '')}` : ''}`);
    if (waiting) console.log(`  ${waiting} event${waiting === 1 ? '' : 's'} waiting to be sent to your dashboard`);
    console.log('');
    return 0;
  }
  if (sub === 'test') {
    const guard = require('../lib/sentinel-guard');
    const rows = guard.runSamples({ env });
    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return rows.every((r) => r.ok) ? 0 : 1; }
    console.log('\n  sample commands through the sentinel guard rules\n');
    for (const r of rows) {
      const mark = r.ok ? ' ' : '!';
      console.log(`  ${mark} ${r.got === 'block' ? 'blocked' : 'allowed'}  ${r.command}`);
      if (r.got === 'block') console.log(`             ${r.reason.replace(/^blocked: /, '')}`);
    }
    const bad = rows.filter((r) => !r.ok);
    const blocked = rows.filter((r) => r.got === 'block').length;
    console.log('');
    console.log(`  ${blocked} of ${rows.length} samples blocked, ${rows.length - blocked} allowed`);
    console.log(bad.length ? `  ${bad.length} sample${bad.length === 1 ? '' : 's'} did not do what was expected (marked !)` : '  every sample did what was expected');
    console.log('');
    return bad.length ? 1 : 0;
  }
  console.error(`  unknown guard command: ${sub}. use install, uninstall, status or test`);
  return 2;
}

// ---------------------------------------------------------------- flush

async function flushCommand(argv, deps = {}) {
  const quiet = argv.includes('--quiet');
  const events = require('../lib/sentinel-events');
  const token = tokenFor(deps);
  let res;
  try { res = await events.flushQueue({ token, base: deps.base, env: deps.env || process.env }); } catch (e) { res = { ok: false, reason: e.message, sent: 0 }; }
  if (!quiet) {
    if (res.ok) console.log(`  sent ${res.sent} queued event${res.sent === 1 ? '' : 's'} to your atris dashboard`);
    else console.log(`  warning: queued events were not sent: ${res.reason}. they stay queued for next time`);
  }
  return 0;
}

// ---------------------------------------------------------------- scheduled

// What a scheduled run does before the paid review: the two free checks,
// wrapped in scan_started and scan_finished events. Never throws.
async function runScheduledFreeChecks(root, deps = {}) {
  const events = require('../lib/sentinel-events');
  const upload = deps.upload !== false;
  const token = upload ? tokenFor(deps) : '';
  const repo = events.repoName(root);
  const started = new Date();
  const say = deps.log || ((m) => console.log(m));
  const out = { agents: null, watch: null, sent: [] };
  const send = async (list) => {
    if (!upload) return { ok: true, skipped: 'no-upload' };
    if (!token) return { ok: false, reason: 'not logged in' };
    try { return await events.postEvents(list, { token, base: deps.base }); } catch (e) { return { ok: false, reason: e.message }; }
  };
  const startEv = events.makeEvent({ kind: 'scan_started', repo, severity: 'info', title: 'Sentinel started its scheduled check of this project.', status: 'resolved', fingerprint: events.fingerprint('scan_started', repo, started.toISOString()), occurredAt: started });
  out.sent.push(await send([startEv]));
  try {
    out.agents = await runAgents(root, { home: false, upload, deps: { ...deps, token } });
    say(`  agent setup check: ${out.agents.result.grade}, ${out.agents.result.findings.length} finding${out.agents.result.findings.length === 1 ? '' : 's'}`);
  } catch (e) { say(`  warning: the agent setup check did not finish: ${e.message}`); }
  try {
    out.watch = await runWatchCheck(root, { upload, deps: { ...deps, token } });
    if (out.watch.result.offline) say('  warning: the dependency check could not reach the osv database this time');
    else say(`  dependency check: ${out.watch.result.affected.length} affected package${out.watch.result.affected.length === 1 ? '' : 's'}`);
  } catch (e) { say(`  warning: the dependency check did not finish: ${e.message}`); }
  const agentsOpen = out.agents ? out.agents.result.findings.length : 0;
  const threats = out.watch && !out.watch.result.offline ? out.watch.result.affected.length : 0;
  const bad = (out.agents && out.agents.result.grade === 'fail') || (out.watch && out.watch.result.affected.some((a) => a.severity === 'critical' || a.severity === 'high'));
  const title = events.fillPlain('Sentinel finished its scheduled check. {a} agent setup findings and {t} dependency threats are open.', { a: ['count', String(agentsOpen), 'some'], t: ['count', String(threats), 'some'] });
  const finished = new Date();
  const endEv = events.makeEvent({ kind: 'scan_finished', repo, severity: bad ? 'high' : 'info', title, status: 'resolved', fingerprint: events.fingerprint('scan_finished', repo, started.toISOString()), occurredAt: finished });
  out.sent.push(await send([endEv]));
  if (upload && token) { try { await events.flushQueue({ token, base: deps.base, env: deps.env || process.env }); } catch {} }
  return out;
}

module.exports = { agentsCommand, guardCommand, watchCommand, flushCommand, runScheduledFreeChecks, runAgents, runWatchCheck, startUpdateNotice };
