// atris campaign keep: a one-minute timer that runs `atris campaign wake`,
// so a campaign's promise to check again holds while no terminal is open
// (atris/features/campaign/promise.md). launchd on macOS, cron elsewhere.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = 'ATRIS_CAMPAIGN_WAKE';

function xml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// The job a timer runs. Campaign wake is the default; `atris idea on` passes
// its own (idea tick every ten minutes).
const CAMPAIGN_WAKE_JOB = Object.freeze({
  name: 'campaign-wake',
  args: ['campaign', 'wake', '--json'],
  every_seconds: 60,
  marker: MARKER,
});

function cronSchedule(seconds) {
  const minutes = Math.max(1, Math.round(Number(seconds || 60) / 60));
  return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
}

// One timer per checkout: the label and marker carry a short hash of its root.
function planKeep({ root, home, platform = process.platform, homeDir = os.homedir(), nodeBin = 'node', atrisBin, envPath = process.env.PATH || '', job = CAMPAIGN_WAKE_JOB }) {
  const slot = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  const every = Number(job.every_seconds) || 60;
  // node by name on the saved PATH, so upgrading node does not break the timer.
  const command = ['/usr/bin/env', nodeBin, atrisBin, ...job.args];
  const logPath = path.join(home, job.log || `${job.name}.log`);
  const base = { root, slot, log_path: logPath, command: command.join(' '), every_seconds: every };
  if (platform === 'darwin') {
    const label = `ai.atris.${job.name}.${slot}`;
    const file = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>${command.map((part) => `<string>${xml(part)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(envPath)}</string><key>ATRIS_SKIP_UPDATE_CHECK</key><string>1</string></dict>
  <key>StartInterval</key><integer>${every}</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
    return { ...base, kind: 'launchd', label, file, contents };
  }
  const marker = `${job.marker || MARKER}_${slot}`;
  const line = `${cronSchedule(every)} cd ${shellQuote(root)} && PATH=${shellQuote(envPath)} ATRIS_SKIP_UPDATE_CHECK=1 ${command.map(shellQuote).join(' ')} >> ${shellQuote(logPath)} 2>&1 # ${marker}`;
  return { ...base, kind: 'cron', marker, crontab_line: line };
}

function withoutMarker(crontab, marker) {
  return String(crontab || '').split('\n').filter((l) => l.trim() && !l.includes(marker)).join('\n');
}

// Replaces any timer this checkout already has. Returns { ok, error? }.
function installKeep(plan, { spawn = spawnSync, uid = process.getuid && process.getuid() } = {}) {
  fs.mkdirSync(path.dirname(plan.log_path), { recursive: true });
  if (plan.kind === 'launchd') {
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
    fs.writeFileSync(plan.file, plan.contents, 'utf8');
    spawn('launchctl', ['bootout', `gui/${uid}/${plan.label}`], { encoding: 'utf8', timeout: 10000 });
    const r = spawn('launchctl', ['bootstrap', `gui/${uid}`, plan.file], { encoding: 'utf8', timeout: 10000 });
    return r.status === 0 ? { ok: true } : { ok: false, error: `launchctl bootstrap failed: ${String(r.stderr || r.stdout || '').trim()}` };
  }
  const existing = spawn('crontab', ['-l'], { encoding: 'utf8', timeout: 10000 });
  const kept = withoutMarker(existing.status === 0 ? existing.stdout : '', plan.marker);
  const r = spawn('crontab', ['-'], { input: `${kept ? `${kept}\n` : ''}${plan.crontab_line}\n`, encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? { ok: true } : { ok: false, error: `crontab failed: ${String(r.stderr || r.stdout || '').trim()}` };
}

function removeKeep(plan, { spawn = spawnSync, uid = process.getuid && process.getuid() } = {}) {
  if (plan.kind === 'launchd') {
    spawn('launchctl', ['bootout', `gui/${uid}/${plan.label}`], { encoding: 'utf8', timeout: 10000 });
    const had = fs.existsSync(plan.file);
    if (had) fs.unlinkSync(plan.file);
    return { ok: true, removed: had };
  }
  const existing = spawn('crontab', ['-l'], { encoding: 'utf8', timeout: 10000 });
  const prior = existing.status === 0 ? String(existing.stdout || '') : '';
  if (!prior.includes(plan.marker)) return { ok: true, removed: false };
  const kept = withoutMarker(prior, plan.marker);
  const r = spawn('crontab', ['-'], { input: kept ? `${kept}\n` : '', encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? { ok: true, removed: true } : { ok: false, error: `crontab failed: ${String(r.stderr || r.stdout || '').trim()}` };
}

module.exports = { MARKER, installKeep, planKeep, removeKeep };
