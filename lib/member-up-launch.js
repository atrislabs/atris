'use strict';

// launchd owns restart and captures both streams. A durable stop marker keeps
// an intentional team sleep from being undone when the user logs in again.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Git linked worktrees share one project supervisor. Separate business
// workspaces retain separate identities even when nested in one repository.
function memberProjectIdentity(root, { spawn = spawnSync } = {}) {
  const real = fs.realpathSync(root);
  const workspace = fs.realpathSync(require('./task-db').workspaceRoot(real));
  if (fs.existsSync(path.join(workspace, '.atris', 'business.json'))) return workspace;
  const top = spawn('git', ['-C', real, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 });
  if (top.error) throw top.error;
  if (top.status === 0 && workspace !== fs.realpathSync(String(top.stdout).trim())) return workspace;
  if (top.status !== 0 && !(top.status === 128 && /not a git repository/i.test(String(top.stderr || '')))) {
    throw new Error(`could not resolve project root: ${String(top.stderr || `git exit ${top.status}`).trim()}`);
  }
  const git = spawn('git', ['-C', real, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 5000 });
  if (git.error) throw git.error;
  if (git.status === 0) return fs.realpathSync(String(git.stdout).trim());
  if (git.status === 128 && /not a git repository/i.test(String(git.stderr || ''))) return real;
  throw new Error(`could not resolve project identity: ${String(git.stderr || `git exit ${git.status}`).trim()}`);
}

function planMemberUpLaunch({ root, nodeBin = process.execPath, cliPath, stateHome, homeDir = os.homedir(), envPath = process.env.PATH || '', taskDb = process.env.ATRIS_TASKS_DB || '', queueRoot = process.env.ATRIS_MEMBER_QUEUE_ROOT || '', max, only } = {}) {
  if (!root || !path.isAbsolute(root) || !cliPath || !path.isAbsolute(cliPath) || !stateHome || !path.isAbsolute(stateHome)) throw new Error('absolute root, CLI and state home are required');
  if (taskDb && !path.isAbsolute(taskDb)) throw new Error('ATRIS_TASKS_DB must be an absolute path for the team launcher');
  if (queueRoot && !path.isAbsolute(queueRoot)) throw new Error('member queue root must be an absolute path');
  const canonicalRoot = fs.realpathSync(root);
  const identity = memberProjectIdentity(canonicalRoot);
  const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const label = `ai.atris.member-up.${key}`;
  const dir = path.join(stateHome, 'member-up', key);
  const file = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  const stdout = path.join(dir, 'supervisor.log');
  const stderr = path.join(dir, 'errors.log');
  const stop = path.join(dir, 'stopped');
  const pidFile = path.join(dir, 'supervisor.pid.json');
  const args = [nodeBin, cliPath, 'member', 'up', '--require-review', '--local-records', '--supervised'];
  if (max) args.push('--max', String(max));
  if (only?.length) args.push('--only', only.join(','));
  if (queueRoot) args.push('--queue-root', queueRoot);
  const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${args.map((v) => `<string>${xml(v)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(canonicalRoot)}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string><key>HOME</key><string>${xml(homeDir)}</string><key>ATRIS_SKIP_UPDATE_CHECK</key><string>1</string>${taskDb ? `<key>ATRIS_TASKS_DB</key><string>${xml(taskDb)}</string>` : ''}</dict>\n<key>Umask</key><integer>63</integer><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer>\n<key>StandardOutPath</key><string>${xml(stdout)}</string><key>StandardErrorPath</key><string>${xml(stderr)}</string>\n</dict></plist>\n`;
  return { root: canonicalRoot, identity, label, dir, file, stdout, stderr, stop, pidFile, args, contents };
}

function installMemberUpLaunchUnlocked(plan, { spawn = spawnSync, uid = process.getuid?.(), preflight = () => '' } = {}) {
  const domain = `gui/${uid}`;
  const { withFileLock } = require('./handoff-wake');
  let hadStop = false;
  const prepared = withFileLock(path.join(plan.dir, 'control.lock'), () => {
    const existing = spawn('launchctl', ['print', `${domain}/${plan.label}`], { encoding: 'utf8', timeout: 5000 });
    if (existing.error) return { ok: false, error: `could not inspect existing launcher: ${existing.error.message}` };
    if (existing.status === 0) return { ok: false, error: 'team launcher is already loaded' };
    if (!/could not find service|no such process/i.test(String(existing.stderr || ''))) return { ok: false, error: `could not inspect existing launcher: ${String(existing.stderr || existing.stdout || `exit ${existing.status}`).trim()}` };
    if (fs.existsSync(plan.file)) return { ok: false, error: `launcher file already exists: ${plan.file}` };
    const reason = preflight();
    if (reason) return { ok: false, error: reason };
    fs.mkdirSync(plan.dir, { recursive: true });
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
    for (const log of [plan.stdout, plan.stderr]) { const fd = fs.openSync(log, 'a', 0o600); fs.closeSync(fd); }
    fs.writeFileSync(plan.file, plan.contents, { encoding: 'utf8', flag: 'wx' });
    hadStop = fs.existsSync(plan.stop);
    if (hadStop) fs.unlinkSync(plan.stop);
    return { ok: true };
  }, { waitMs: 5000 });
  if (!prepared.ok) return prepared;
  // launchctl can wait for the child to start. Do not hold control.lock here:
  // the child needs that same lock to check the stop marker and publish its PID.
  const out = spawn('launchctl', ['bootstrap', domain, plan.file], { encoding: 'utf8', timeout: 10000 });
  if (out.error || out.status !== 0) {
    withFileLock(path.join(plan.dir, 'control.lock'), () => {
      if (!fs.existsSync(plan.stop)) fs.writeFileSync(plan.stop, 'stopped after uncertain installation\n');
    }, { waitMs: 5000 });
    const stop = spawn('launchctl', ['kill', 'SIGTERM', `${domain}/${plan.label}`], { encoding: 'utf8', timeout: 5000 });
    const stopError = stop.error?.message || (stop.status !== 0 ? String(stop.stderr || stop.stdout || `exit ${stop.status}`).trim() : '');
    return { ok: false, error: `launchctl bootstrap failed: ${out.error?.message || String(out.stderr || out.stdout || `exit ${out.status}`).trim()}${stopError ? `; could not confirm stop: ${stopError}` : ''}`, file: plan.file };
  }
  return { ok: true, label: plan.label, log: plan.stdout, errors: plan.stderr, running: 'unverified' };
}

function resumeMemberUpLaunchUnlocked(plan, { spawn = spawnSync, uid = process.getuid?.() } = {}) {
  const { withFileLock } = require('./handoff-wake');
  let stopWasPresent = false;
  const prepared = withFileLock(path.join(plan.dir, 'control.lock'), () => {
    if (!fs.existsSync(plan.file)) return { ok: false, error: 'team launcher is not installed' };
    stopWasPresent = fs.existsSync(plan.stop);
    if (stopWasPresent) fs.unlinkSync(plan.stop);
    return { ok: true };
  }, { waitMs: 5000 });
  if (!prepared.ok) return prepared;
  const domain = `gui/${uid}`;
  const status = spawn('launchctl', ['print', `${domain}/${plan.label}`], { encoding: 'utf8', timeout: 5000 });
  let out;
  const currentPid = status.status === 0 && /\bpid = (\d+)/.exec(String(status.stdout || ''));
  if (!stopWasPresent && currentPid) {
    try { process.kill(Number(currentPid[1]), 0); return { ok: true, label: plan.label, log: plan.stdout, errors: plan.stderr, running: true, already_running: true }; }
    catch (error) { if (error.code !== 'ESRCH') return { ok: false, error: `could not inspect running supervisor: ${error.message}` }; }
  }
  if (status.error) out = status;
  else if (status.status === 0) out = spawn('launchctl', ['kickstart', '-k', `${domain}/${plan.label}`], { encoding: 'utf8', timeout: 15000 });
  else if (/could not find service|no such process/i.test(String(status.stderr || ''))) out = spawn('launchctl', ['bootstrap', domain, plan.file], { encoding: 'utf8', timeout: 15000 });
  else out = status;
  if (out.error || out.status !== 0) {
    withFileLock(path.join(plan.dir, 'control.lock'), () => {
      if (!fs.existsSync(plan.stop)) fs.writeFileSync(plan.stop, 'stopped; resume failed\n');
    }, { waitMs: 5000 });
    const stop = spawn('launchctl', ['kill', 'SIGTERM', `${domain}/${plan.label}`], { encoding: 'utf8', timeout: 5000 });
    const stopError = stop.error?.message || (stop.status !== 0 ? String(stop.stderr || stop.stdout || `exit ${stop.status}`).trim() : '');
    return { ok: false, error: `launchctl kickstart failed: ${out.error?.message || String(out.stderr || out.stdout || `exit ${out.status}`).trim()}${stopError ? `; could not confirm stop: ${stopError}` : ''}` };
  }
  return { ok: true, label: plan.label, log: plan.stdout, errors: plan.stderr, running: 'unverified' };
}

// ps start time prevents a recycled PID from being mistaken for a prior run.
function processStartIdentity(pid, { spawn = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid supervisor pid');
  const result = spawn('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
  if (result.error) throw result.error;
  if (result.status !== 0 || !String(result.stdout || '').trim()) throw new Error(`could not read process identity for pid ${pid}`);
  return String(result.stdout).trim().replace(/\s+/g, ' ');
}

function controlOperation(plan, name, operation) {
  let result;
  try {
    result = require('./handoff-wake').withFileLock(path.join(plan.dir, 'operation.lock'), operation, { waitMs: 30000 });
  } catch (error) {
    result = { ok: false, error: error.message || String(error) };
  }
  if (!result.ok) {
    try {
      fs.mkdirSync(plan.dir, { recursive: true });
      fs.appendFileSync(plan.stderr, `${new Date().toISOString()} ${name}: ${result.error}\n`, { mode: 0o600 });
    } catch (error) {
      result.error += `; could not write error log: ${error.message}`;
    }
  }
  return result;
}
function installMemberUpLaunch(plan, options = {}) {
  return controlOperation(plan, 'install', () => installMemberUpLaunchUnlocked(plan, options));
}
function resumeMemberUpLaunch(plan, options = {}) {
  return controlOperation(plan, 'resume', () => resumeMemberUpLaunchUnlocked(plan, options));
}
module.exports = { planMemberUpLaunch, installMemberUpLaunch, resumeMemberUpLaunch, processStartIdentity, memberProjectIdentity };
