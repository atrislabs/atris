'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const autoland = require('../lib/autoland');

function repoRoot(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return cwd;
  return result.stdout.trim() || cwd;
}

function projectName(root) {
  return path.basename(root);
}

function flag(args, name, fallback = '') {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

function runOwnCli(root, cliArgs) {
  const bin = path.join(root, 'bin', 'atris.js');
  const argv = fs.existsSync(bin) ? [process.execPath, [bin, ...cliArgs]] : ['atris', [cliArgs].flat()];
  const result = spawnSync(argv[0], argv[1], { cwd: root, encoding: 'utf8', timeout: 300000 });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function readProjection(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), 'utf8');
    const projection = JSON.parse(raw);
    return Array.isArray(projection.tasks) ? projection.tasks : [];
  } catch (err) {
    return [];
  }
}

function landSummarySafe(root) {
  try {
    return require('./land').landSummary(root);
  } catch (err) {
    return null;
  }
}

function evaluateQueue(root, { strictVerify }) {
  const cliArgs = ['task', 'auto-accept-certified', '--dry-run', '--json', '--limit', '50'];
  if (strictVerify) cliArgs.push('--strict-verify');
  const result = runOwnCli(root, cliArgs);
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch (err) {
    return [];
  }
}

function plainReason(reason) {
  const map = {
    denied_tag_billing: 'money — yours to approve',
    denied_tag_deploy: 'a deploy — yours to approve',
    denied_tag_security: 'security — yours to approve',
    denied_tag_customer: 'customer-facing — yours to approve',
    denied_tag_external: 'outward-facing — yours to approve',
    denied_tag_feedback: 'customer feedback — yours to approve',
    denied_tag_voice: 'voice/comms — yours to approve',
    needs_second_reviewer_or_third_pass: 'needs one more independent check first',
    not_agent_certified: 'not certified yet',
    insufficient_review_passes: 'not enough review passes yet',
    strict_verify_missing: 'no recorded check command to re-run',
    verify_failed: 'its check command failed on re-run',
    proof_unmerged_or_draft_pr_boundary: 'its proof points at an unmerged draft',
  };
  return map[reason] || reason.replace(/_/g, ' ');
}

function showStatus(root, args) {
  const json = args.includes('--json');
  const policy = autoland.readPolicy(root);
  const enabled = Boolean(policy && policy.enabled);
  const strictVerify = policy ? policy.strict_verify !== false : true;
  const results = evaluateQueue(root, { strictVerify })
    .filter((r) => r.reason !== 'not_in_review');
  const wouldLand = results.filter((r) => r.action === 'would_accept');
  const blocked = results.filter((r) => r.action !== 'would_accept');
  const tasks = readProjection(root);
  const waiting = autoland.waitingOnHuman(tasks);

  if (json) {
    console.log(JSON.stringify({
      enabled,
      policy,
      heartbeat_installed: autoland.cronInstalled(root),
      would_land: wouldLand,
      blocked,
      waiting_on_human: waiting,
    }, null, 2));
    return 0;
  }

  console.log('');
  console.log(`autoland — certified work lands itself; you keep the irreversible calls`);
  console.log('');
  console.log(`  policy: ${enabled ? `on (flipped by ${policy.enabled_by}${policy.enabled_at ? ` on ${String(policy.enabled_at).slice(0, 10)}` : ''})` : 'off — everything waits for you'}`);
  console.log(`  heartbeat: ${autoland.cronInstalled(root) ? 'running hourly' : 'not installed'}`);
  if (policy && policy.imessage_to) console.log(`  daily message: ${policy.imessage_to} at ${policy.digest_hour ?? autoland.DEFAULT_DIGEST_HOUR}:00`);
  console.log('');
  if (wouldLand.length > 0) {
    console.log(`  ready to land on their own: ${wouldLand.length}`);
    for (const r of wouldLand.slice(0, 10)) console.log(`    lands itself  ${r.ref}`);
  } else {
    console.log('  nothing is ready to land on its own right now.');
  }
  const humanOnly = blocked.filter((r) => String(r.reason || '').startsWith('denied_tag_'));
  const needsWork = blocked.filter((r) => !String(r.reason || '').startsWith('denied_tag_'));
  if (humanOnly.length > 0) {
    console.log(`  yours to approve (protected lanes): ${humanOnly.length}`);
    for (const r of humanOnly.slice(0, 10)) console.log(`    waits for you  ${r.ref} — ${plainReason(r.reason)}`);
  }
  if (needsWork.length > 0) {
    console.log(`  not ready yet: ${needsWork.length}`);
    for (const r of needsWork.slice(0, 10)) console.log(`    held back      ${r.ref} — ${plainReason(String(r.reason || ''))}`);
  }
  if (waiting.length > 0) {
    console.log('');
    console.log(`  waiting on a human right now: ${waiting.length}, oldest ${waiting[0].hours}h`);
  }
  console.log('');
  if (!enabled) console.log("  flip it on: atris autoland on   (one decision; everything after is receipts)");
  console.log('');
  return 0;
}

function turnOn(root, args) {
  const owner = flag(args, '--as', os.userInfo().username);
  const to = flag(args, '--to', '');
  const digestHour = Number(flag(args, '--digest-hour', autoland.DEFAULT_DIGEST_HOUR));
  const alarmHours = Number(flag(args, '--alarm-hours', autoland.DEFAULT_ALARM_HOURS));
  const policy = autoland.writePolicy(root, {
    enabled: true,
    enabled_by: owner,
    enabled_at: new Date().toISOString(),
    imessage_to: to || null,
    digest_hour: Number.isFinite(digestHour) ? digestHour : autoland.DEFAULT_DIGEST_HOUR,
    alarm_hours: Number.isFinite(alarmHours) && alarmHours > 0 ? alarmHours : autoland.DEFAULT_ALARM_HOURS,
    strict_verify: !args.includes('--no-strict-verify'),
  });
  const cronOk = autoland.installCron(root);
  console.log('');
  console.log('autoland is on.');
  console.log(`  certified, verified, reversible work now lands itself, accepted as ${owner}.`);
  console.log('  protected lanes (money, deploys, security, customer, outward) still wait for you.');
  console.log(`  heartbeat: ${cronOk ? 'installed, runs hourly' : 'could not install cron — run atris autoland tick yourself'}`);
  if (policy.imessage_to) {
    console.log(`  daily message to ${policy.imessage_to} at ${policy.digest_hour}:00; anything waiting on you past ${policy.alarm_hours}h pings you.`);
  } else {
    console.log('  no phone number set — digest goes to the log only. add one: atris autoland on --to <your number>');
  }
  console.log('  turn it off any time: atris autoland off');
  console.log('');
  return 0;
}

function turnOff(root) {
  const policy = autoland.readPolicy(root) || {};
  autoland.writePolicy(root, { ...policy, enabled: false, disabled_at: new Date().toISOString() });
  const cronOk = autoland.uninstallCron(root);
  console.log('');
  console.log('autoland is off. everything waits for your accept again.');
  console.log(`  heartbeat ${cronOk ? 'removed' : 'removal failed — check crontab -l'}.`);
  console.log('');
  return 0;
}

function runDigest(root, args, { forceSend = false } = {}) {
  const policy = autoland.readPolicy(root) || {};
  const tasks = readProjection(root);
  const accepted = autoland.acceptedInLastDay(tasks);
  const text = autoland.composeDigest({
    accepted,
    waiting: autoland.waitingOnHuman(tasks),
    landed: landSummarySafe(root),
    project: projectName(root),
  });
  console.log(text);
  // the full story: what each piece actually was, in its own words
  const byRef = new Map(tasks.map((t) => [t.display_id || t.legacy_ref || t.id, t]));
  const storied = accepted.auto.filter((item) => {
    const t = byRef.get(item.ref);
    return t && (t.review?.landing?.happened || t.metadata?.landing_happened);
  });
  if (storied.length > 0) {
    console.log('');
    for (const item of storied) {
      const t = byRef.get(item.ref);
      const happened = String(t.review?.landing?.happened || t.metadata?.landing_happened || '').replace(/\s+/g, ' ').slice(0, 160);
      console.log(`  ${item.ref}  ${happened}`);
    }
  }
  const shouldSend = (forceSend || args.includes('--send')) && policy.imessage_to;
  if (shouldSend) {
    const sent = autoland.sendImessage(root, policy.imessage_to, text);
    console.log(sent.ok ? `(sent to ${policy.imessage_to})` : `(send failed: ${sent.output})`);
    return sent.ok ? 0 : 1;
  }
  return 0;
}

function runTick(root, args) {
  const json = args.includes('--json');
  const policy = autoland.readPolicy(root);
  const receipt = { at: new Date().toISOString(), landed: [], alarms: 0, digest_sent: false, enabled: Boolean(policy && policy.enabled) };
  if (!policy || policy.enabled !== true) {
    if (json) console.log(JSON.stringify(receipt));
    else console.log('autoland is off; tick did nothing.');
    return 0;
  }

  // 1. land what is eligible — the policy is the standing authorization
  const cliArgs = ['task', 'auto-accept-certified', '--json', '--limit', '12'];
  if (policy.strict_verify !== false) cliArgs.push('--strict-verify');
  const accept = runOwnCli(root, cliArgs);
  try {
    const parsed = JSON.parse(accept.stdout);
    receipt.landed = (parsed.results || []).filter((r) => r.action === 'accepted').map((r) => r.ref);
  } catch (err) {
    receipt.accept_error = accept.stderr.slice(0, 200) || 'auto-accept output unreadable';
  }

  // 2. alarm on anything waiting on a human past the line
  const state = autoland.readState(root);
  const tasks = readProjection(root);
  const waiting = autoland.waitingOnHuman(tasks);
  const alarmHours = Number(policy.alarm_hours) || autoland.DEFAULT_ALARM_HOURS;
  const due = autoland.dueForAlarm(waiting, state, { alarmHours });
  if (due.length > 0 && policy.imessage_to) {
    const text = autoland.composeAlarm({ waiting: due, project: projectName(root), alarmHours });
    const sent = autoland.sendImessage(root, policy.imessage_to, text);
    if (sent.ok) {
      autoland.markAlerted(state, due);
      receipt.alarms = due.length;
    }
  }

  // 3. daily digest at the configured hour
  const today = new Date().toISOString().slice(0, 10);
  const digestHour = Number(policy.digest_hour ?? autoland.DEFAULT_DIGEST_HOUR);
  if (new Date().getHours() === digestHour && state.last_digest_date !== today) {
    const text = autoland.composeDigest({
      accepted: autoland.acceptedInLastDay(tasks),
      waiting,
      landed: landSummarySafe(root),
      project: projectName(root),
    });
    if (policy.imessage_to) {
      const sent = autoland.sendImessage(root, policy.imessage_to, text);
      receipt.digest_sent = sent.ok;
    }
    receipt.digest_text = text;
    state.last_digest_date = today;
  }
  autoland.writeState(root, state);

  if (json) console.log(JSON.stringify(receipt));
  else {
    console.log(`autoland tick: ${receipt.landed.length} landed${receipt.landed.length ? ` (${receipt.landed.join(', ')})` : ''}, ${receipt.alarms} alarms, digest ${receipt.digest_sent ? 'sent' : 'not due'}`);
  }
  return 0;
}

function showHelp() {
  console.log('');
  console.log('atris autoland — you approve the policy once; certified work lands itself');
  console.log('');
  console.log('finished work that passed its checks and two independent reviews lands');
  console.log('automatically with a receipt. money, deploys, security, customer, and');
  console.log('outward-facing work always waits for you.');
  console.log('');
  console.log('  atris autoland                     what would land, what waits for you');
  console.log('  atris autoland on [--to <phone>]   flip it on: hourly heartbeat, daily');
  console.log('                                     message, ping when something waits');
  console.log('                                     on you past 24h');
  console.log('  atris autoland off                 back to approving every item');
  console.log('  atris autoland digest [--send]     the daily message, now');
  console.log('  atris autoland tick                one heartbeat (what the hourly cron runs)');
  console.log('');
  return 0;
}

function autolandCommand(args = []) {
  const [sub, ...rest] = args;
  if (!sub || sub.startsWith('--')) return showStatus(repoRoot(), args);
  if (sub === 'help' || sub === '--help' || sub === '-h') return showHelp();
  const root = repoRoot();
  if (sub === 'on') return turnOn(root, rest);
  if (sub === 'off') return turnOff(root);
  if (sub === 'tick') return runTick(root, rest);
  if (sub === 'digest') return runDigest(root, rest);
  if (sub === 'status') return showStatus(root, rest);
  console.error(`atris autoland: unknown subcommand '${sub}' (try: atris autoland help)`);
  return 1;
}

module.exports = { autolandCommand };
