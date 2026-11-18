'use strict';

// Autoland: the owner approves the policy once, then certified work lands
// itself. Humans keep the genuinely irreversible lanes (the denied tags in
// lib/auto-accept-certified.js); everything else is verified, reversible,
// and receipted, so waiting for a human click adds latency, not safety.

const fs = require('fs');
const path = require('path');
const { stateHome, samePath } = require('./state-home');
const os = require('os');
const { spawnSync } = require('child_process');
const { computeTrustTier } = require('./trust-tiers');
const toolPath = require('./tool-path');

const DEFAULT_DIGEST_HOUR = 9;
const DEFAULT_ALARM_HOURS = 24;
const OPERATOR_WHY = /\b(sav(?:e|es|ing)|burn(?:s|ing)?|wast(?:e|es|ing)|cost(?:s|ing)?|prevent\w*|reduc\w*|risk|stop(?:s|ping)?|break(?:s|ing)?|fail(?:s|ing)?|slow(?:s|er)?|faster|cheaper|easier|clearer|safer|simpler|trust|revenue|instead|rather than|so(?: that)?|because)\b/i;
const AGENT_JARGON = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b|--[a-z][a-z-]*\b|\bCLI-\d+\b/;
const RESULT_ULID = /\b[0-9A-HJKMNP-TV-Z]{20,}\b/;
const RESULT_TICKET = /\b[A-Z]{2,4}-\d+\b/;
const RESULT_FILE_PATH = /\b(?:[\w.-]+\/)*[\w.-]+\.(?:js|md|py|json|ts)(?::\d+)?\b/i;
const RESULT_COMMAND = /--|->|\b(?:npm|node|grep|git)\s+/i;
const SHELL_COMMAND_FRAGMENT = /\b(?:npm|node|git|grep)\s+[^\s,;]+|->/i;
const TRAILING_FRAGMENT_WORDS = new Set([
  'after',
  'and',
  'as',
  'at',
  'because',
  'before',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'over',
  'so',
  'than',
  'that',
  'the',
  'to',
  'under',
  'with',
  'without',
]);
const COMPLETE_TRAILING_PHRASE = /\b(?:enough|what|which)\s+to\s+(?:act|focus|work)\s+on[.!?]$/i;

function policyPath(root) {
  return path.join(root, '.atris', 'policy', 'autoland.json');
}

function statePath(root) {
  return path.join(root, '.atris', 'state', 'autoland.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Default is ON: agents are good enough that a growing review queue is
// latency, not safety. The denied tags keep the irreversible lanes human.
// A missing policy file means "on, owner inferred"; only an explicit
// `atris autoland off` (enabled: false) turns it off.
function inferOwner(root) {
  const git = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' });
  const name = git.status === 0 ? String(git.stdout || '').trim() : '';
  return name || os.userInfo().username;
}

function defaultPolicy(root) {
  return {
    enabled: true,
    enabled_by: inferOwner(root),
    enabled_at: null,
    daily_experiment: true,
    default: true,
  };
}

function readPolicy(root) {
  const policy = readJson(policyPath(root), null);
  if (!policy || typeof policy !== 'object') return defaultPolicy(root);
  return policy;
}

function writePolicy(root, policy) {
  writeJson(policyPath(root), policy);
  return policy;
}

function readState(root) {
  const state = readJson(statePath(root), {});
  if (!state.alerts || typeof state.alerts !== 'object') state.alerts = {};
  return state;
}

function writeState(root, state) {
  writeJson(statePath(root), state);
}

// The standing authorization cmdAutoAcceptCertified consults: live accepts
// are allowed without a per-run human confirmation only when the owner has
// flipped the policy on for this workspace.
function liveAcceptAuthorization(root = process.cwd()) {
  const policy = readPolicy(root);
  if (!policy || policy.enabled !== true) return { ok: false, reason: 'autoland_policy_off' };
  const actor = String(policy.enabled_by || '').trim();
  if (!actor) return { ok: false, reason: 'autoland_policy_missing_owner' };
  return { ok: true, actor, policy: 'autoland', strictVerify: policy.strict_verify !== false };
}

// Tick receipts are local file reads and prove the loop ran. A receipt from
// the last couple of hours means the hourly pass is alive; older or missing
// means surfaces must not promise "next tick" landing.
const HEARTBEAT_LIVE_HOURS = 2;
const STALE_HEARTBEAT_LANDING = 'once the hourly heartbeat runs (start one with atris autoland tick)';

function lastTickAgeHours(root) {
  try {
    const runsDir = path.join(root, 'atris', 'runs');
    const newest = fs.readdirSync(runsDir)
      .filter((f) => f.startsWith('autoland-tick-') && f.endsWith('.json'))
      .sort()
      .pop();
    if (!newest) return null;
    const stamp = fs.statSync(path.join(runsDir, newest)).mtimeMs;
    return (Date.now() - stamp) / 3_600_000;
  } catch {
    return null;
  }
}

function heartbeatIsLive(root) {
  const ageHours = lastTickAgeHours(root);
  return ageHours !== null && ageHours <= HEARTBEAT_LIVE_HOURS;
}

// Whether the hourly pass is scheduled, asked of the scheduler itself: on a
// Mac the LaunchAgent file exists and launchctl knows its label, or the
// crontab holds this project's live line. true, false, or null when the
// scheduler could not be asked. A flag saved at `autoland on` time would
// keep saying "installed" for a job someone deleted.
function heartbeatLiveness(root, deps = {}) {
  return schedulerState(root, deps).installed;
}

const MAC_CRON_NOTE = 'cron runs it outside your login on this Mac, so scheduled runs cannot use the GitHub sign-in; run atris autoland on again to fix it';

// The second argument is the scheduler's answer (schedulerState); when it is
// left out the scheduler is asked here.
function heartbeatStatusText(root, schedule) {
  const state = schedule && typeof schedule === 'object' ? schedule : schedulerState(root);
  const ageHours = lastTickAgeHours(root);
  const ageText = ageHours === null
    ? null
    : ageHours < 1 ? 'under an hour' : `${Math.floor(ageHours)}h`;
  const macCron = state.mac_cron_only === true ? `; ${MAC_CRON_NOTE}` : '';
  // Evidence first: a receipt from the last couple of hours proves the loop is
  // alive no matter what the scheduler says. The hourly schedule makes two
  // missed hours an outage rather than jitter, and a heartbeat that has gone
  // quiet is the single most useful thing this line can say, because that is
  // the state nobody notices.
  if (ageHours !== null && ageHours <= HEARTBEAT_LIVE_HOURS) return `running hourly (last tick ${ageText} ago)${macCron}`;
  if (ageHours !== null) return `SILENT - last tick ${ageText} ago; run atris autoland tick${macCron}`;
  if (state.stale_program) return 'set up, but the job runs a program that is gone - run atris autoland on to repair it';
  if (state.installed === false && state.plist_unloaded) return 'set up but not loaded - run atris autoland on';
  if (state.installed === false) return 'not installed - run atris autoland on';
  if (state.installed === true && macCron) return `installed, but no tick has ever run; ${MAC_CRON_NOTE}`;
  if (state.installed === true) return 'installed, but no tick has ever run - run atris autoland tick';
  return 'unknown - run atris autoland on to check and repair';
}

// Operator-facing schedule: only promise "next tick" when a recent receipt
// proves the loop is alive. Otherwise name the honest gate.
function whenAutolandLands(root) {
  return heartbeatIsLive(root) ? 'on the next tick' : STALE_HEARTBEAT_LANDING;
}

function certifiedWorkLandsPhrase(root) {
  return heartbeatIsLive(root)
    ? 'certified work lands itself'
    : `certified work lands ${STALE_HEARTBEAT_LANDING}`;
}

function cronMarker(root) {
  const slug = path.basename(root).replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  return `ATRIS_AUTOLAND_${slug}`;
}

// The one command both schedulers run: cd into the project, run the tick,
// append to the log.
function buildTickCommand(root) {
  const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const node = process.execPath;
  // A project without its own copy of the CLI runs this one, by full path.
  // A bare `atris` is not on cron's short PATH: one project's hourly pass
  // printed "atris: command not found" every hour from 2026-10-27, and its
  // finished jobs were never checked or landed.
  const bin = path.join(root, 'bin', 'atris.js');
  const cliBin = fs.existsSync(bin) ? bin : path.join(__dirname, '..', 'bin', 'atris.js');
  const logDir = path.join(stateHome(), '.atris', 'overnight');
  const logFile = path.join(logDir, `autoland-${path.basename(root)}.log`);
  const invoke = cliBin.endsWith('.js') ? `${quote(node)} ${quote(cliBin)}` : cliBin;
  return `cd ${quote(root)} && ${invoke} autoland tick >> ${quote(logFile)} 2>&1`;
}

const TICK_MINUTE = 14;

function buildCronLine(root) {
  return `${TICK_MINUTE} * * * * ${buildTickCommand(root)} # ${cronMarker(root)}`;
}

function readCrontab(spawn = spawnSync) {
  const result = spawn('crontab', ['-l'], { encoding: 'utf8', timeout: 10000 });
  return result.status === 0 ? String(result.stdout || '') : '';
}

function applyCrontab(content, spawn = spawnSync, injected = spawn !== spawnSync) {
  if (blockedUnderTest('crontab', { injected })) return false;
  const result = spawn('crontab', ['-'], { input: content, encoding: 'utf8', timeout: 10000 });
  return result.status === 0;
}

function installCron(root, spawn = spawnSync) {
  fs.mkdirSync(path.join(stateHome(), '.atris', 'overnight'), { recursive: true });
  const marker = cronMarker(root);
  const kept = readCrontab(spawn).split(/\r?\n/).filter((line) => line.trim() && !line.includes(marker));
  const next = `${kept.join('\n')}${kept.length ? '\n' : ''}${buildCronLine(root)}\n`;
  return applyCrontab(next, spawn);
}

function uninstallCron(root, spawn = spawnSync) {
  const marker = cronMarker(root);
  const kept = readCrontab(spawn).split(/\r?\n/).filter((line) => line.trim() && !line.includes(marker));
  return applyCrontab(kept.length ? `${kept.join('\n')}\n` : '', spawn);
}

// --- the scheduler on a Mac ---
// cron on macOS runs outside the login session, and gh keeps its token in the
// login keychain, so every cron pass read pull requests signed out (HTTP 401)
// and never landed anything by itself. A LaunchAgent bootstrapped into the
// person's gui domain runs inside the login and can use the sign-in.

// The job name from the folder name alone. Two projects can share it
// (work/api and personal/api); see launchAgentFor.
function launchAgentLabel(root) {
  return `ai.atris.autoland.${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function schedulerDeps(deps = {}) {
  return {
    platform: deps.platform || process.platform,
    homeDir: deps.homeDir || os.homedir(),
    spawn: deps.spawn || spawnSync,
    injected: Boolean(deps.spawn),
    uid: deps.uid != null ? deps.uid : (typeof process.getuid === 'function' ? process.getuid() : 0),
  };
}

function xmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlUnescape(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// The folders a job file runs in: each `cd` in its shell command and its
// WorkingDirectory.
function plistFolders(text) {
  const body = String(text || '');
  const folders = [];
  const work = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(body);
  if (work) folders.push(xmlUnescape(work[1]));
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(body);
  if (array) {
    const args = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1]));
    const words = args[1] === '-c' && args.length >= 3 ? shellWords(args[2]) : [];
    words.forEach((word, i) => { if (word === 'cd' && words[i + 1]) folders.push(words[i + 1]); });
  }
  return folders;
}

// Whether a job file belongs to another project: it names the folders it
// runs in and this project is not one of them. A file that names no folder
// stays this project's, so a hand-made job is never doubled.
function plistRunsElsewhere(text, root, homeDir) {
  const folders = plistFolders(text).map((folder) => folder.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homeDir));
  if (!folders.length) return false;
  return !folders.some((folder) => samePath(folder, root) || path.resolve(folder) === path.resolve(root));
}

// This project's job: the folder name label, unless a job by that name
// already runs another project; then the label carries a short tag of the
// full path. A tagged job that already exists is always this project's.
function launchAgentFor(root, d) {
  const dir = path.join(d.homeDir, 'Library', 'LaunchAgents');
  const base = launchAgentLabel(root);
  const tag = require('crypto').createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 8);
  const tagged = `${base}-${tag}`;
  const at = (label) => ({ label, file: path.join(dir, `${label}.plist`) });
  if (fs.existsSync(at(tagged).file)) return { ...at(tagged), shared_name: base };
  const text = readText(at(base).file);
  if (text === null || !plistRunsElsewhere(text, root, d.homeDir)) return { ...at(base), shared_name: null };
  return { ...at(tagged), shared_name: base };
}

const CALENDAR_BLOCK = /<key>StartCalendarInterval<\/key>\s*(?:<array>[\s\S]*?<\/array>|<dict>[\s\S]*?<\/dict>)/;

// `timing` is an old file's StartCalendarInterval block, kept when a stale
// job is rewritten.
function buildLaunchAgentPlist(root, label = launchAgentLabel(root), timing = null) {
  const out = path.join(stateHome(), '.atris', 'overnight', `${label}.out`);
  const calendar = timing || `<key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Minute</key>
      <integer>${TICK_MINUTE}</integer>
    </dict>
  </array>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlText(toolPath.SCHEDULE_PATH)}</string>
  </dict>
  <key>Label</key>
  <string>${xmlText(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${xmlText(buildTickCommand(root))}</string>
  </array>
  <key>StandardErrorPath</key>
  <string>${xmlText(out)}</string>
  <key>StandardOutPath</key>
  <string>${xmlText(out)}</string>
  ${calendar}
</dict>
</plist>
`;
}

// Shell words, enough for the commands these jobs run: quotes, backslashes
// and the '\'' join.
function shellWords(command) {
  const words = [];
  let word = null;
  let quote = '';
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = ''; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && i + 1 < s.length) word += s[++i];
      else word += c;
      continue;
    }
    if (/\s/.test(c)) { if (word !== null) words.push(word); word = null; continue; }
    if (word === null) word = '';
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\' && i + 1 < s.length) word += s[++i];
    else word += c;
  }
  if (word !== null) words.push(word);
  return words;
}

// The first program the job runs that no longer exists, such as a node from
// a Homebrew folder that an upgrade removed, or ''.
function missingProgram(text) {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(String(text || ''));
  if (!array) return '';
  const args = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1]));
  const words = args[1] === '-c' && args.length >= 3 ? shellWords(args[2]) : args;
  let program = true;
  for (const word of words) {
    if (['&&', '||', ';', '|'].includes(word)) { program = true; continue; }
    if (word === 'cd') { program = false; continue; }
    if (word === 'autoland' || /^\d?>/.test(word)) program = false;
    if (program && word.startsWith('/') && !fs.existsSync(word)) return word;
  }
  return '';
}

// A test run must never load a job into the real login session or rewrite the
// real crontab. Under the test runner, a scheduler tool found in the system
// folders, or a LaunchAgents folder in the real home, is refused. A fake
// runner aimed at the real home is refused always: no real caller does that.
function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  return '';
}

function underTestRunner() {
  if (process.env.NODE_TEST_CONTEXT) return true;
  if (process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test-'))) return true;
  return /\.test\.[cm]?js$/.test(String(process.argv[1] || ''));
}

function blockedUnderTest(tool, { injected = false, homeDir = null } = {}) {
  let realHome = '';
  try { realHome = os.userInfo().homedir; } catch {}
  const realHomeAimed = Boolean(homeDir) && (!realHome || samePath(homeDir, realHome));
  if (injected && realHomeAimed) return true;
  if (!underTestRunner()) return false;
  if (realHomeAimed) return true;
  if (injected) return false;
  const found = onPath(tool);
  return !found || /^\/(?:usr\/)?s?bin\//.test(found);
}

function liveMarkerLine(line, marker) {
  const trimmed = String(line).trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  return new RegExp(`(^|[^A-Za-z0-9_])${marker}(?![A-Za-z0-9_])`).test(trimmed);
}

// The crontab as read, or null when it could not be read. A crontab that
// does not exist yet reads as empty.
function probeCrontab(d, timeout = 10000) {
  const read = d.spawn('crontab', ['-l'], { encoding: 'utf8', timeout });
  if (read.status === 0) return String(read.stdout || '');
  if (read.error || read.signal) return null;
  return /no crontab/i.test(String(read.stderr || '')) ? '' : null;
}

// Drops this project's live line and leaves every other line, commented ones
// included, exactly as it was.
function removeLiveCronLines(root, d) {
  const table = probeCrontab(d);
  if (table === null) return { ok: false, removed: 0, error: 'the crontab could not be read' };
  const marker = cronMarker(root);
  const lines = table.split('\n');
  const kept = lines.filter((line) => !liveMarkerLine(line, marker));
  const removed = lines.length - kept.length;
  if (!removed) return { ok: true, removed: 0 };
  if (blockedUnderTest('crontab', { injected: d.injected })) return { ok: false, removed: 0, error: 'refused to change the real crontab under test' };
  const wrote = d.spawn('crontab', ['-'], { input: kept.join('\n'), encoding: 'utf8', timeout: 10000 });
  return wrote.status === 0 ? { ok: true, removed } : { ok: false, removed: 0, error: String(wrote.stderr || 'crontab failed').trim().slice(0, 200) };
}

function launchctlKnows(label, d) {
  const read = d.spawn('launchctl', ['print', `gui/${d.uid}/${label}`], { encoding: 'utf8', timeout: 5000 });
  return read.status === 0;
}

function launchctlSaid(result, fallback) {
  return String(result.stderr || result.stdout || fallback).trim().slice(0, 200);
}

function errText(err) {
  return String((err && (err.code || err.message)) || err).slice(0, 200);
}

// When the login job cannot be set up, the cron line keeps the pass running:
// a live line already there stays as it is, otherwise one is added.
function cronFallback(root, d, out, why) {
  const table = probeCrontab(d);
  const live = table !== null && table.split('\n').some((line) => liveMarkerLine(line, cronMarker(root)));
  const ok = live || installCron(root, d.spawn);
  return { ...out, ok, kind: 'cron', fallback: true, launchd_error: why, kept_cron_line: live };
}

// A job file written before 2026-11-17 carries PATH=/usr/bin:/bin, where gh
// does not live, so every gh call in the tick said "gh is not installed".
// Only the PATH string changes; the command and timing stay as they were.
// A file with no PATH entry is left alone (launchd's own PATH applies, and
// the tick adds the package folders itself).
const PLIST_PATH_ENTRY = /(<key>EnvironmentVariables<\/key>\s*<dict>[\s\S]*?<key>PATH<\/key>\s*<string>)([\s\S]*?)(<\/string>)/;

function plistPathValue(text) {
  const match = PLIST_PATH_ENTRY.exec(String(text || ''));
  return match ? xmlUnescape(match[2]) : null;
}

function plistWithToolPath(text) {
  const value = plistPathValue(text);
  if (value === null || !toolPath.schedulePathLacksTools(value)) return null;
  return String(text).replace(PLIST_PATH_ENTRY, (_, open, _old, close) => `${open}${xmlText(toolPath.repairedSchedulePath(value))}${close}`);
}

// Whether launchd is running the job right now. A reload would kill a tick
// in the middle of a landing.
function launchctlRunning(label, d) {
  const read = d.spawn('launchctl', ['print', `gui/${d.uid}/${label}`], { encoding: 'utf8', timeout: 5000 });
  return read.status === 0 && /^\s*state = running\b/m.test(String(read.stdout || ''));
}

// Install the hourly pass. Mac: one LaunchAgent per project, and no live cron
// line beside it. Anywhere else: the crontab line, as before.
function installSchedule(root, deps = {}) {
  const d = schedulerDeps(deps);
  if (d.platform !== 'darwin') {
    if (d.injected && blockedUnderTest('crontab', { injected: true, homeDir: d.homeDir })) {
      return { ok: false, kind: 'cron', error: 'refused to change the real crontab under test' };
    }
    return { ok: installCron(root, d.spawn), kind: 'cron' };
  }
  if (blockedUnderTest('launchctl', { injected: d.injected, homeDir: d.homeDir })) {
    return { ok: false, kind: 'launchd', label: launchAgentLabel(root), error: 'refused to touch the real login session under test' };
  }
  const { label, file, shared_name: sharedName } = launchAgentFor(root, d);
  const out = { ok: false, kind: 'launchd', label, plist_path: file, kept_existing: false, removed_cron_lines: 0, shared_name: sharedName };
  try { fs.mkdirSync(path.join(stateHome(), '.atris', 'overnight'), { recursive: true }); } catch {}
  const existing = readText(file);
  const gone = existing === null ? '' : missingProgram(existing);
  if (existing !== null && !gone) {
    // Its minutes and command may have been tuned by hand: keep the file, and
    // only load it when launchctl does not know it yet. A short PATH is the
    // one thing fixed in it, and the job reloaded, unless a tick is running.
    out.kept_existing = true;
    const repaired = plistWithToolPath(existing);
    const known = launchctlKnows(label, d);
    if (repaired !== null) {
      if (known && launchctlRunning(label, d)) {
        out.path_repair_waiting = 'a tick is running now; run atris autoland on again after it ends to give the job the full PATH';
      } else {
        try { fs.writeFileSync(file, repaired, 'utf8'); } catch (err) {
          return { ...out, error: `could not fix the PATH in ${file} (${errText(err)})` };
        }
        out.path_repaired = toolPath.repairedSchedulePath(plistPathValue(existing));
        if (known) d.spawn('launchctl', ['bootout', `gui/${d.uid}/${label}`], { encoding: 'utf8', timeout: 10000 });
        const loaded = d.spawn('launchctl', ['bootstrap', `gui/${d.uid}`, file], { encoding: 'utf8', timeout: 10000 });
        if (loaded.status !== 0) return { ...out, error: launchctlSaid(loaded, 'launchctl bootstrap failed') };
      }
    } else if (!known) {
      const loaded = d.spawn('launchctl', ['bootstrap', `gui/${d.uid}`, file], { encoding: 'utf8', timeout: 10000 });
      if (loaded.status !== 0) return { ...out, error: launchctlSaid(loaded, 'launchctl bootstrap failed') };
    }
  } else {
    // A new job, or one whose program is gone: write the file, keeping an old
    // file's timing, then load it fresh.
    const timing = gone ? (CALENDAR_BLOCK.exec(existing) || [null])[0] : null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buildLaunchAgentPlist(root, label, timing), 'utf8');
    } catch (err) {
      if (gone) return { ...out, error: `could not rewrite ${file} (${errText(err)})` };
      return cronFallback(root, d, out, `could not write ${file} (${errText(err)})`);
    }
    d.spawn('launchctl', ['bootout', `gui/${d.uid}/${label}`], { encoding: 'utf8', timeout: 10000 });
    const loaded = d.spawn('launchctl', ['bootstrap', `gui/${d.uid}`, file], { encoding: 'utf8', timeout: 10000 });
    if (loaded.status !== 0) {
      const why = launchctlSaid(loaded, 'launchctl bootstrap failed');
      // A file that never loaded would load at next login beside the cron line.
      try { fs.unlinkSync(file); } catch {}
      return cronFallback(root, d, out, why);
    }
    if (gone) out.repaired = gone;
  }
  out.ok = true;
  const cron = removeLiveCronLines(root, d);
  out.removed_cron_lines = cron.removed;
  if (!cron.ok) out.cron_error = cron.error;
  return out;
}

function uninstallSchedule(root, deps = {}) {
  const d = schedulerDeps(deps);
  if (d.platform !== 'darwin') {
    if (d.injected && blockedUnderTest('crontab', { injected: true, homeDir: d.homeDir })) {
      return { ok: false, kind: 'cron', error: 'refused to change the real crontab under test' };
    }
    return { ok: uninstallCron(root, d.spawn), kind: 'cron' };
  }
  if (blockedUnderTest('launchctl', { injected: d.injected, homeDir: d.homeDir })) {
    return { ok: false, kind: 'launchd', label: launchAgentLabel(root), error: 'refused to touch the real login session under test' };
  }
  const { label, file } = launchAgentFor(root, d);
  const errors = [];
  d.spawn('launchctl', ['bootout', `gui/${d.uid}/${label}`], { encoding: 'utf8', timeout: 10000 });
  if (launchctlKnows(label, d)) errors.push(`the job ${label} is still loaded; run launchctl bootout gui/${d.uid}/${label}`);
  const hadPlist = fs.existsSync(file);
  let removedPlist = false;
  if (hadPlist) {
    try { fs.unlinkSync(file); removedPlist = true; } catch (err) {
      errors.push(`could not delete ${file} (${errText(err)}); delete it by hand or it loads again at next login`);
    }
  }
  const cron = removeLiveCronLines(root, d);
  if (!cron.ok) errors.push(cron.error);
  return { ok: errors.length === 0, kind: 'launchd', label, plist_path: file, removed_plist: removedPlist, removed_cron_lines: cron.removed, error: errors.join('; ') || undefined };
}

// What the scheduler holds for this project right now. Read-only: the plist
// and launchctl's answer on a Mac, the crontab everywhere. The crontab read
// is short so a stalled crontab cannot hold up a status line for long.
const STATUS_PROBE_MS = 1000;

function schedulerState(root, deps = {}) {
  const d = schedulerDeps(deps);
  const marker = cronMarker(root);
  const cronLive = () => {
    const table = probeCrontab(d, STATUS_PROBE_MS);
    return table === null ? null : table.split('\n').some((line) => liveMarkerLine(line, marker));
  };
  if (d.platform !== 'darwin') {
    const live = cronLive();
    return { installed: live, kind: live ? 'cron' : null, mac_cron_only: false };
  }
  const { label, file } = launchAgentFor(root, d);
  const text = readText(file);
  const plist = text !== null || fs.existsSync(file);
  const gone = text === null ? '' : missingProgram(text);
  const stale = gone ? { stale_program: gone } : {};
  if (text !== null && plistWithToolPath(text) !== null) stale.stale_path = plistPathValue(text);
  if (plist && launchctlKnows(label, d)) return { installed: true, kind: 'launchd', label, mac_cron_only: false, ...stale };
  const live = cronLive();
  if (live) return { installed: true, kind: 'cron', label, mac_cron_only: true };
  if (plist) return { installed: false, kind: null, label, plist_unloaded: true, mac_cron_only: false, ...stale };
  return { installed: live, kind: null, label, mac_cron_only: false };
}

function certifiedAtMs(task) {
  const iso = task.metadata?.agent_certified_at;
  if (iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  return Number(task.updated_at) || Date.now();
}

function waitingHours(task, now = Date.now()) {
  return Math.floor((now - certifiedAtMs(task)) / 3600000);
}

// Tasks that are certified and pending, finished work sitting on the
// human side of the fence, whatever the reason.
function waitingOnHuman(tasks, now = Date.now()) {
  return (tasks || [])
    .filter((t) => t.status === 'review')
    .filter((t) => String(t.review?.approval_status || t.metadata?.approval_status || 'pending') === 'pending')
    .filter((t) => t.review?.agent_certified === true || t.metadata?.agent_certified === true)
    .map((t) => ({
      ref: t.display_id || t.legacy_ref || t.id,
      title: String(t.title || '').slice(0, 200),
      result: String(t.result || t.metadata?.result || '').slice(0, 220),
      tag: String(t.tag || ''),
      hours: waitingHours(t, now),
      member: String(t.claimed_by || t.assigned_to || '').trim(),
    }))
    .sort((a, b) => b.hours - a.hours);
}

function acceptedInLastDay(tasks, now = Date.now()) {
  const auto = [];
  const human = [];
  for (const t of tasks || []) {
    const acceptedAt = Date.parse(t.metadata?.accepted_at || '') || 0;
    if (!acceptedAt || now - acceptedAt > 24 * 3600000) continue;
    const entry = {
      ref: t.display_id || t.legacy_ref || t.id,
      title: String(t.title || '').slice(0, 120),
      result: String(t.result || t.metadata?.result || '').slice(0, 220),
      happened: String(t.review?.landing?.happened || t.metadata?.landing_happened || '').slice(0, 300),
      member: String(t.claimed_by || t.metadata?.executed_by || t.assigned_to || '').trim(),
      // Accepted is a review verdict; only a passed landing proof is landed.
      landed: t.metadata?.landing?.status === 'landed',
    };
    if (t.metadata?.auto_accepted_at) auto.push(entry);
    else human.push(entry);
  }
  return { auto, human };
}

function plur(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function pauseReasonDigestLabel(reason) {
  if (reason === 'auth-required') return 'awaiting login';
  if (reason === 'model-unavailable') return 'awaiting an available model';
  if (reason === 'rate-limit-exceeded-wall') return 'waiting for the rate-limit reset';
  if (reason === 'stale' || reason === 'paused-idle') return 'stale after the idle window';
  return 'paused for operator action';
}

function normalizeReasonTally(value) {
  const tally = {};
  if (!value || typeof value !== 'object') return tally;
  for (const [reason, count] of Object.entries(value)) {
    const cleanReason = String(reason || '').trim();
    const n = Number(count) || 0;
    if (cleanReason && n > 0) tally[cleanReason] = (tally[cleanReason] || 0) + n;
  }
  return tally;
}

function heldReasonTally(janitor) {
  const holds = janitor?.mission_holds && typeof janitor.mission_holds === 'object'
    ? Object.values(janitor.mission_holds)
    : [];
  const tally = {};
  for (const hold of holds) {
    const reason = String(hold?.reason || '').trim();
    if (reason) tally[reason] = (tally[reason] || 0) + 1;
  }
  if (holds.length > 0) return tally;
  return normalizeReasonTally(janitor?.missions_held_reasons);
}

function pushJanitorMissionReasonLines(lines, janitor) {
  const held = heldReasonTally(janitor);
  for (const [reason, count] of Object.entries(held).sort()) {
    lines.push(`held: ${plur(count, 'mission')} ${pauseReasonDigestLabel(reason)} (${reason})`);
  }
  const stopped = normalizeReasonTally(janitor?.mission_stop_reasons || janitor?.missions_stopped_reasons);
  for (const [reason, count] of Object.entries(stopped).sort()) {
    lines.push(`stopped: ${plur(count, 'mission')} ${pauseReasonDigestLabel(reason)} (${reason})`);
  }
}

function pushLandingSweepLines(lines, landingSweep) {
  if (!landingSweep || typeof landingSweep !== 'object') return;
  const stale = Array.isArray(landingSweep.stale) ? landingSweep.stale : [];
  const staleCount = Number(landingSweep.stale_count) || stale.length;
  if (staleCount > 0) {
    const oldest = stale[0];
    const oldestText = oldest
      ? `; oldest: ${oldest.name} (${Number(oldest.activityHours || oldest.ageHours || 0)}h)`
      : '';
    lines.push(`stuck in the air past 48h: ${plur(staleCount, 'piece')} need${staleCount === 1 ? 's' : ''} a human${oldestText}; inspect: atris land`);
  }
  const human = Array.isArray(landingSweep.human) ? landingSweep.human : [];
  const humanCount = Number(landingSweep.human_count) || human.length;
  if (humanCount > 0) {
    const first = human[0] ? ` ${finishThought(human[0], 130)}` : '';
    const more = humanCount > 1 ? `; ${humanCount - 1} more` : '';
    lines.push(`cleanup needs a human:${first}${more}`);
  }
}

function pushWaitingWishLines(lines, waitingWishes) {
  const wishes = (Array.isArray(waitingWishes) ? waitingWishes : [])
    .filter((wish) => wish && String(wish.text || '').trim());
  if (!wishes.length) return;
  lines.push(`${plur(wishes.length, 'wish')} waiting on you:`);
  for (const wish of wishes.slice(0, 2)) {
    const text = finishThought(String(wish.text || '').replace(/[.\s]+$/, ''), 90);
    const need = cutAtWord(String(wish.need || 'answer the open question before it can start'), 120);
    lines.push(`- ${text}: ${need}`);
  }
  const hidden = Math.max(0, wishes.length - 2);
  if (hidden > 0) lines.push(`- ${plur(hidden, 'more wish')} waiting on an answer`);
}

function cutAtWord(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}...`;
}

function stripDanglingFragment(text) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  while (out.includes('(') && out.lastIndexOf('(') > out.lastIndexOf(')')) {
    out = out.slice(0, out.lastIndexOf('(')).trim();
  }
  out = out.replace(/[,\s;:]+$/g, '').trim();
  while (out) {
    const withoutPunctuation = out.replace(/[.!?]+$/g, '').trim();
    const word = (withoutPunctuation.match(/[A-Za-z]+$/) || [''])[0].toLowerCase();
    if (!TRAILING_FRAGMENT_WORDS.has(word)) break;
    out = withoutPunctuation.slice(0, Math.max(0, withoutPunctuation.length - word.length)).replace(/[,\s;:]+$/g, '').trim();
  }
  return out;
}

// A line ends where a thought ends. Long lines close at their last complete
// clause inside the budget and read whole: no ellipsis, nothing dangling.
// Only when a line has no clause boundary at all does a word cut remain.
function finishThought(text, max = 160) {
  const clean = stripDanglingFragment(String(text || '').replace(/\s+/g, ' ').trim().replace(/[,;:\s]+$/, ''));
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > max * 0.3) return stripDanglingFragment(cut.slice(0, sentence + 1));
  const clause = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' ('), cut.lastIndexOf(': '));
  if (clause > max * 0.45) return stripDanglingFragment(cut.slice(0, clause));
  const space = cut.lastIndexOf(' ');
  return stripDanglingFragment(cut.slice(0, space > max * 0.6 ? space : max));
}

function digestMoveLine(move) {
  if (move.kind === 'mission_ready') {
    const title = String(move.title || '').trim();
    const boundary = title.search(/[:,]\s+/);
    const clause = (boundary >= 0 ? title.slice(0, boundary) : title).trim();
    const clauseWords = clause.split(/\s+/).filter(Boolean).length;
    const afterColon = boundary >= 0 && title[boundary] === ':'
      ? title.slice(boundary + 1).replace(/\([^)]*\)/g, '').trim()
      : '';
    const candidate = afterColon && clauseWords <= 5 ? finishThought(afterColon, 80) : clause;
    const completeClause = candidate && candidate.length <= 80
      ? candidate.charAt(0).toLowerCase() + candidate.slice(1).replace(/[.!?]+$/g, '')
      : '';
    const label = finishThought(completeClause || String(move.label || '').replace(/^#\d+\s+/, ''), 80);
    return label
      ? `review proof${move.owner ? ` from ${move.owner}` : ''} for ${label} so finished work can leave the queue`
      : 'review the finished mission proof so accepted work can leave the queue';
  }
  return `${finishThought(move.title, 140)}${move.owner ? ` (best fit: ${move.owner})` : ''}`;
}

function historicalLandingText(text, max = 160) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\bas exists and not empty\b/gi, 'as a saved file that exists and is not empty')
    .trim();
  return finishThought(clean, max);
}

function operatorReady(text) {
  const value = String(text || '');
  return OPERATOR_WHY.test(value) && !AGENT_JARGON.test(value);
}

function hasAgentJargon(text) {
  return AGENT_JARGON.test(String(text || ''));
}

function explainResult(text, options = {}) {
  const raw = String(text || '');
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, reason: 'result must say what someone can do now and why it matters.' };
  if (raw.includes('\n') || raw.includes('\r')) return { ok: false, reason: 'result must be one sentence, not a paragraph.' };
  if (value.length < 30) return { ok: false, reason: 'result is too short to explain what changed for a human.' };
  if (value.length > 180) return { ok: false, reason: 'result must stay under 180 characters so it survives briefs.' };
  if (!/[.!?]$/.test(value)) return { ok: false, reason: 'result must end as a complete sentence with a period, question mark, or exclamation point.' };
  const sentenceStops = value.match(/[.!?]/g) || [];
  if (sentenceStops.length !== 1) return { ok: false, reason: 'result must be exactly one complete sentence.' };
  if (RESULT_ULID.test(value)) return { ok: false, reason: 'result should explain the gain, not include database ids.' };
  if (RESULT_TICKET.test(value)) return { ok: false, reason: 'result should not include ticket ids.' };
  if (RESULT_FILE_PATH.test(value)) return { ok: false, reason: 'result should not include file paths.' };
  if (!options.allowCommandMention && RESULT_COMMAND.test(value)) {
    return { ok: false, reason: 'result should not include command syntax or flags.' };
  }
  const finalWord = (value.replace(/[.!?]+$/g, '').match(/[A-Za-z]+$/) || [''])[0].toLowerCase();
  if (TRAILING_FRAGMENT_WORDS.has(finalWord) && !COMPLETE_TRAILING_PHRASE.test(value)) {
    return { ok: false, reason: 'result ends mid-thought; finish the sentence with the actual human gain.' };
  }
  if (!operatorReady(value)) {
    return { ok: false, reason: 'result needs a plain operator why: say who can do what now, and why it saves time, reduces risk, increases trust, or helps users.' };
  }
  return { ok: true, reason: null };
}

// One line per piece, in the work's own words: the landing sentence beats
// the task title, because titles are written for the queue, not for a text.
// The cut is generous on purpose: a specific sentence the reader trusts
// (what happened + how big + how we know) beats a short one they must chase.
function digestLine(item) {
  const result = String(item.result || '').replace(/^completed:\s*/i, '').split(/(?<=[.!?])\s+/)[0] || '';
  const happened = String(item.happened || '').replace(/^completed:\s*/i, '').split(/(?<=[.!?])\s+/)[0] || '';
  const title = clarify(String(item.title || '').replace(/^Mission XP:\s*/i, ''));
  const source = result.length >= 12 ? result : (happened.length >= 12 && operatorReady(happened) ? happened : (operatorReady(title) ? title : ''));
  if (!source) return '';
  const line = finishThought(source.replace(/[.\s]+$/, ''), 160);
  if (!operatorReady(line) && source === result && happened.length >= 12 && operatorReady(happened)) {
    const fallback = finishThought(happened.replace(/[.\s]+$/, ''), 160);
    if (operatorReady(fallback)) return fallback.charAt(0).toLowerCase() + fallback.slice(1);
  }
  return line.charAt(0).toLowerCase() + line.slice(1);
}

function unexplainedSummaryRows(items, label) {
  const count = (items || []).length;
  if (count === 0) return [];
  if (label === 'landed') {
    return [`${plur(count, 'landed result')} stayed hidden because ${count === 1 ? 'its outcome was' : 'their outcomes were'} unclear`];
  }
  if (label === 'accepted') {
    return [`${plur(count, 'accepted result')} stayed hidden because ${count === 1 ? 'its outcome was' : 'their outcomes were'} unclear`];
  }
  if (label === 'in review') {
    return [`${plur(count, 'review')} stayed hidden because ${count === 1 ? 'its next action was' : 'their next actions were'} unclear`];
  }
  return [`${plur(count, label)} stayed hidden because ${count === 1 ? 'its meaning was' : 'their meanings were'} unclear`];
}

// Some older surfaces still need a readable fallback for rough text, but the
// digest paths above now hide agent-speak until a result sentence exists.
function dejargon(line, options = {}) {
  let value = String(line || '')
    .replace(/--([a-z][a-z-]*)/g, (_match, flag) => flag.replace(/-/g, ' '))
    .replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi, match => match.replace(/_/g, ' '))
    .replace(/\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g, match => match.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
  if (options.preserveTickets !== true) value = value.replace(/\(\s*CLI-\d+\s*\)|\bCLI-\d+\b/g, '');
  return value.replace(/\s+/g, ' ').trim();
}

// The clarity gate in one call: strip what an operator can't act on (flag
// dashes, task ids, snake_case) and close the sentence on a whole clause, so
// any title or line borrowed from the queue reaches a human actionable at a
// glance. One sentence in, one operator-ready sentence out. Content always
// ships, the gate only changes how it reads.
function clarify(text, max = 160) {
  return finishThought(dejargon(text), max);
}

// The mission loop files a check-off every time it stops instead of
// inventing work; those all say the same thing, so they collapse into one line.
function isCleanStop(item) {
  return /no concrete follow-up|did not start fake work|stopped with reason/i.test(String(item.happened || ''))
    || /^(Mission XP:\s*)?Decide and start the next useful mission/i.test(String(item.title || ''));
}

function hiddenMoveText(count, { more = false } = {}) {
  const label = plur(count, `${more ? 'more queued ' : 'queued '}move`);
  return count === 1
    ? `${label} stays hidden until its owner writes a clear next action`
    : `${label} stay hidden until their owners write clear next actions`;
}

function memberTrustLabel(member, root) {
  if (!member) return '';
  const tier = computeTrustTier(member, root);
  if (tier === 'trusted') return ` (${member})`;
  if (tier === 'standard') return ` (${member}, newer, spot-checked)`;
  return ` (${member}, needs review)`;
}

// Short enough for one iMessage, plain enough to read walking to the car.
// Every line answers: what happened, how big, how we know. It names the work
// because "7 things landed" tells the score, not the story, and it always
// ends with what's waiting and what to do next, because those are the only
// lines that ask anything of the reader.
// The morning list: protected work that passed both checks waits only on
// the owner's yes. One line each, then one command that says yes to all.
function checkedProtectedLines(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.ref);
  if (!list.length) return [];
  const lines = [`checked twice, waiting only on your yes (${list.length}):`];
  for (const r of list.slice(0, 8)) {
    const what = finishThought(String(r.title || r.ref), 90);
    const state = r.undone ? ', part of this work was undone' : (r.merged ? '' : ', not merged yet');
    lines.push(`- ${r.ref} ${what}${r.lane && !r.undone ? ` (${r.lane})` : ''}${state}`);
  }
  if (list.length > 8) lines.push(`- ${list.length - 8} more: atris task reviews`);
  // Only merged work is in the one tap; a yes never finishes unmerged code.
  const ready = list.filter((r) => r.merged);
  if (ready.length) lines.push(`yes to all merged: ${ready.map((r) => `atris task accept ${r.ref}`).join(' && ')}`);
  return lines;
}

function composeDigest({ accepted, waiting, protectedWaiting = [], checkedProtected = [], waitingWishes = [], landed, project, nextMoves = [], acceptAll = false, reapError = null, janitor = null, landingSweep = null, fullStory = false, root = process.cwd() }) {
  const lines = [];
  lines.push(`atris ${project}: last 24 hours`);
  const autoCount = accepted.auto.length;
  const humanCount = accepted.human.length;
  const landedCount = accepted.auto.filter((item) => item.landed === true).length;
  // "N landed" only when every one of them proved it; otherwise say both.
  const finished = landedCount === autoCount ? `${autoCount} landed` : `${autoCount} accepted, ${landedCount} landed`;
  const finishedWord = landedCount === autoCount ? 'landed' : 'accepted';
  const wishWaits = (Array.isArray(waitingWishes) ? waitingWishes : [])
    .filter((wish) => wish && String(wish.text || '').trim());
  if (autoCount > 0) {
    // Three results, air between them, the rest on ask: the whole message
    // fits a laptop screen with no scrolling. Reading it is one glance.
    const stops = accepted.auto.filter(isCleanStop);
    const work = accepted.auto
      .filter((item) => !isCleanStop(item))
      .map((item) => ({ item, line: digestLine(item) }));
    const ready = work.filter(({ line }) => line && operatorReady(line));
    const unexplainedWork = work.filter(({ line }) => !line || !operatorReady(line));
    const visibleWork = ready.slice(0, 3);
    const held = Math.max(0, ready.length - visibleWork.length) + (stops.length > 0 ? 1 : 0);
    if (visibleWork.length > 0) {
      // The header states the actual bar: under accept-all the claim
      // "verified twice" would be a lie the operator builds trust on.
      lines.push(acceptAll
        ? `${finished}; ${plur(ready.length, 'clear result')}, protected lanes held back for you:`
        : `${finished}; ${plur(ready.length, 'clear result')}, each verified twice with proof on file:`);
      for (const { item, line } of visibleWork) {
        lines.push('');
        lines.push(`- ${line || item.ref}${memberTrustLabel(item.member, root)}`);
      }
      lines.push('');
      if (held > 0) {
        lines.push(fullStory
          ? `${plur(held, 'more result')} in the full story below`
          : `${plur(held, 'more result')} when you want them: atris autoland digest`);
      }
    } else {
      lines.push(`${finished} with proof on file; no clear result was ready to show:`);
    }
    for (const row of unexplainedSummaryRows(unexplainedWork, finishedWord)) lines.push(row);
  }
  if (autoCount + humanCount === 0) lines.push('nothing finished in the last day');
  if (waiting.length > 0) {
    // The only lines that ask the reader to act, so they name what's asking.
    const waitingWork = waiting.map((item) => ({ item, line: digestLine(item) }));
    const explainedWaiting = waitingWork.filter(({ line }) => line && operatorReady(line));
    const unexplainedWaiting = waitingWork.filter(({ line }) => !line || !operatorReady(line));
    lines.push(`task approvals waiting on you (${explainedWaiting.length} clear next actions/${waiting.length} total; approve or bounce: atris task reviews):`);
    for (const { item, line } of explainedWaiting.slice(0, 2)) {
      lines.push(`- ${finishThought(line, 140)}${item.hours >= 12 ? ` (${item.hours}h)` : ''}`);
    }
    for (const row of unexplainedSummaryRows(unexplainedWaiting, 'in review')) lines.push(`- ${row}`);
    const hiddenWaiting = Math.max(0, explainedWaiting.length - 2);
    if (hiddenWaiting > 0) lines.push(`- ${hiddenWaiting} more clear review actions`);
  }
  for (const row of checkedProtectedLines(checkedProtected)) lines.push(row);
  const protectedCount = Array.isArray(protectedWaiting) ? protectedWaiting.length : 0;
  if (protectedCount > 0) {
    lines.push(`${plur(protectedCount, 'protected review')} waiting on you; inspect: atris task reviews`);
  } else if (waiting.length === 0 && wishWaits.length === 0) {
    lines.push('task approvals waiting on you: nothing');
  }
  pushWaitingWishLines(lines, wishWaits);
  if (landed && landed.branches > 0) {
    const staleCount = Number(landingSweep?.stale_count) || (Array.isArray(landingSweep?.stale) ? landingSweep.stale.length : 0);
    const freshness = landed.due > 0
      ? `, ${landed.due} overdue`
      : (staleCount > 0 ? `, ${staleCount} stale` : ', all fresh');
    lines.push(`in the air: ${plur(landed.branches, 'piece')}${freshness} (atris land)`);
  }
  if (reapError) lines.push(`cleanup trouble: the landing sweep failed (${reapError}) - run: atris land --reap`);
  pushLandingSweepLines(lines, landingSweep);
  // The janitor's day in one line: stale paused missions stopped and merged
  // worktrees cleared since the last digest. Silence when it did nothing.
  const missionsStopped = Number(janitor?.missions_stopped) || 0;
  const worktreesReaped = Number(janitor?.worktrees_reaped) || 0;
  if (janitor) pushJanitorMissionReasonLines(lines, janitor);
  if (missionsStopped > 0 || worktreesReaped > 0) {
    lines.push(`tidied up: ${plur(missionsStopped, 'stale mission')} stopped, ${plur(worktreesReaped, 'merged worktree')} cleared`);
  }
  // nextMoves: array of {title, owner}, or {moves, unexplained} where
  // unexplained counts queue items whose sentence carries no operator why.
  // Those are counted, not shown. A raw title the reader can't act on is
  // noise here and a writing bug at its source.
  const nextInfo = Array.isArray(nextMoves)
    ? { moves: nextMoves, unexplained: 0 }
    : (nextMoves || { moves: [], unexplained: 0 });
  const moves = (nextInfo.moves || []).filter((move) => move && move.title).slice(0, 3);
  const unexplained = Number(nextInfo.unexplained || 0);
  if (moves.length > 0) {
    lines.push('next, if you agree:');
    for (const move of moves) {
      lines.push(`- ${digestMoveLine(move)}`);
    }
    if (unexplained > 0) lines.push(`- ${hiddenMoveText(unexplained, { more: true })}`);
  } else if (unexplained > 0) {
    lines.push(hiddenMoveText(unexplained));
  }
  if (!fullStory && !lines.some((line) => line.includes('atris autoland digest'))) {
    lines.push('the full story: atris autoland digest');
  }
  return lines.join('\n');
}

// The moment something lands, the operator hears it in one glance: the
// landing sentence each piece wrote for a day-one PM at finish time, its
// author, nothing else. Rough sentences get de-jargoned, never hidden.
function composeLiveUpdate({ landedRefs, tasks, project, root = process.cwd() }) {
  const byRef = new Map((tasks || []).map((t) => [String(t.display_id || t.legacy_ref || t.id), t]));
  const items = (landedRefs || []).map((ref) => {
    const t = byRef.get(String(ref));
    if (!t) return { title: String(ref) };
    return {
      ref: String(ref),
      title: String(t.title || '').slice(0, 200),
      result: String(t.result || t.metadata?.result || '').slice(0, 220),
      happened: String(t.review?.landing?.happened || t.metadata?.landing_happened || '').slice(0, 300),
      member: String(t.claimed_by || t.metadata?.executed_by || t.assigned_to || '').trim(),
    };
  }).filter((item) => !isCleanStop(item));
  if (!items.length) return '';
  const lines = [`atris ${project}: just landed`];
  const work = items.map((item) => ({ item, line: digestLine(item) }));
  const ready = work.filter(({ line }) => line && operatorReady(line));
  const unexplained = work.filter(({ line }) => !line || !operatorReady(line));
  for (const { item, line } of ready.slice(0, 3)) {
    lines.push('');
    lines.push(`- ${finishThought(line, 160)}${memberTrustLabel(item.member, root)}`);
  }
  for (const row of unexplainedSummaryRows(unexplained, 'landed')) {
    lines.push('');
    lines.push(row);
  }
  if (ready.length > 3) {
    lines.push('');
    lines.push(`and ${plur(ready.length - 3, 'more piece')}: atris autoland digest`);
  }
  return lines.join('\n');
}

function composeAlarm({ waiting, project, alarmHours }) {
  const worst = waiting[0];
  return [
    `atris ${project}: ${plur(waiting.length, 'piece')} of finished work ${waiting.length === 1 ? 'has' : 'have'} been waiting on you for over ${alarmHours}h`,
    `oldest: ${worst.ref} (${worst.hours}h), ${worst.title}`,
    'approve or bounce: atris task reviews',
  ].join('\n');
}

// Alarm dedupe: a task pings at most once per alarm window.
function dueForAlarm(waiting, state, { alarmHours = DEFAULT_ALARM_HOURS, now = Date.now() } = {}) {
  const due = [];
  for (const item of waiting) {
    if (item.hours < alarmHours) continue;
    const lastAlert = Date.parse(state.alerts[item.ref] || '') || 0;
    if (now - lastAlert < alarmHours * 3600000) continue;
    due.push(item);
  }
  return due;
}

function markAlerted(state, items, now = Date.now()) {
  for (const item of items) state.alerts[item.ref] = new Date(now).toISOString();
  return state;
}

function sendImessage(root, to, text) {
  const bin = path.join(root, 'bin', 'atris.js');
  const argv = fs.existsSync(bin)
    ? [process.execPath, [bin, 'imessage', 'send', '--to', to, '--text', text, '--approved']]
    : ['atris', ['imessage', 'send', '--to', to, '--text', text, '--approved']];
  const result = spawnSync(argv[0], argv[1], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return { ok: result.status === 0, output: String(result.stdout || result.stderr || '').trim().slice(0, 300) };
}

module.exports = {
  DEFAULT_ALARM_HOURS,
  DEFAULT_DIGEST_HOUR,
  STALE_HEARTBEAT_LANDING,
  acceptedInLastDay,
  buildCronLine,
  certifiedWorkLandsPhrase,
  clarify,
  composeAlarm,
  composeDigest,
  checkedProtectedLines,
  composeLiveUpdate,
  buildLaunchAgentPlist,
  buildTickCommand,
  dueForAlarm,
  digestLine,
  dejargon,
  explainResult,
  heartbeatIsLive,
  heartbeatLiveness,
  heartbeatStatusText,
  installCron,
  installSchedule,
  launchAgentLabel,
  liveAcceptAuthorization,
  markAlerted,
  operatorReady,
  hasAgentJargon,
  voicePatterns: Object.freeze({
    agentJargon: AGENT_JARGON,
    filePath: RESULT_FILE_PATH,
    rawUlid: RESULT_ULID,
    shellCommand: SHELL_COMMAND_FRAGMENT,
  }),
  historicalLandingText,
  policyPath,
  readPolicy,
  readState,
  sendImessage,
  statePath,
  schedulerState,
  uninstallSchedule,
  waitingOnHuman,
  whenAutolandLands,
  writePolicy,
  writeState,
};
