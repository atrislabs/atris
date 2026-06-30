const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function stripMissionQuotes(value) {
  const text = String(value || '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

function extractMissionFlag(text, flagName) {
  const source = String(text || '');
  const inline = new RegExp(`(^|\\s)${flagName}=([^\\s]+)(?=\\s|$)`).exec(source);
  if (inline) {
    return {
      value: inline[2],
      text: `${source.slice(0, inline.index)}${inline[1] || ''}${source.slice(inline.index + inline[0].length)}`.replace(/\s+/g, ' ').trim(),
    };
  }
  const split = new RegExp(`(^|\\s)${flagName}\\s+([^\\s]+)(?=\\s|$)`).exec(source);
  if (split) {
    return {
      value: split[2],
      text: `${source.slice(0, split.index)}${split[1] || ''}${source.slice(split.index + split[0].length)}`.replace(/\s+/g, ' ').trim(),
    };
  }
  return { value: null, text: source.trim() };
}

function stripBooleanFlag(text, flagName) {
  return String(text || '').replace(new RegExp(`(^|\\s)${flagName}(?=\\s|$)`, 'g'), ' ').replace(/\s+/g, ' ').trim();
}

function hasBooleanFlag(text, flagName) {
  return new RegExp(`(^|\\s)${flagName}(?=\\s|$)`).test(String(text || ''));
}

function missionRunIntentFromMessage(message) {
  const text = String(message || '').trim();
  const match = /^atris\s+mission\s+run(?:\s+([\s\S]+))?$/i.exec(text);
  if (!match) return null;

  let rest = String(match[1] || '').trim();
  const ownerFlag = extractMissionFlag(rest, '--owner');
  rest = ownerFlag.text;
  const maxTicksFlag = extractMissionFlag(rest, '--max-ticks');
  rest = maxTicksFlag.text;
  const maxWallFlag = extractMissionFlag(rest, '--max-wall');
  rest = maxWallFlag.text;
  const cadenceFlag = extractMissionFlag(rest, '--cadence');
  rest = cadenceFlag.text;
  const noRun = hasBooleanFlag(rest, '--no-run') || hasBooleanFlag(rest, '--no-loop');
  const noComplete = hasBooleanFlag(rest, '--no-complete');
  rest = stripBooleanFlag(stripBooleanFlag(stripBooleanFlag(rest, '--no-run'), '--no-loop'), '--no-complete');
  rest = rest.replace(/(^|\s)--json(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

  const wantsLongRun = /\b(24\s*h|24\s*hours?|overnight|forever)\b/i.test(text);
  return {
    objective: stripMissionQuotes(rest),
    owner: ownerFlag.value || process.env.ATRIS_AGENT_ID || 'mission-lead',
    maxTicks: positiveInteger(maxTicksFlag.value, wantsLongRun ? 96 : 1),
    maxWallSeconds: positiveInteger(maxWallFlag.value, wantsLongRun ? 86400 : 300),
    cadence: cadenceFlag.value || (wantsLongRun ? '15m' : ''),
    noRun,
    noComplete,
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return fallback;
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  return JSON.parse(text);
}

function runCliJsonSync(cliPath, args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(options.env || {}),
    },
  });
  if (result.error) {
    return { ok: false, status: 1, error: result.error.message || String(result.error), stdout: result.stdout || '', stderr: result.stderr || '' };
  }
  let payload = null;
  try { payload = parseJson(result.stdout); } catch (error) {
    return { ok: false, status: result.status || 1, error: `invalid JSON: ${error.message}`, stdout: result.stdout || '', stderr: result.stderr || '' };
  }
  return { ok: result.status === 0 && payload?.ok !== false, status: result.status || 0, payload, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runCliJsonStreaming(cliPath, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const proc = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ...(options.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    let killedByTimeout = false;
    let progressTimer = null;
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      let payload = null;
      let error = '';
      try { payload = parseJson(stdout); } catch (err) { error = `invalid JSON: ${err.message}`; }
      resolve({
        ok: status === 0 && !error && payload?.ok !== false,
        status: status || 0,
        payload,
        stdout,
        stderr,
        error: killedByTimeout ? 'timeout' : error,
      });
    };
    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000).unref();
    }, options.timeoutMs || 660000);
    progressTimer = options.onProgress
      ? setInterval(() => {
          options.onProgress(`still_running ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}`);
        }, options.progressEveryMs || 15000)
      : null;
    if (progressTimer?.unref) progressTimer.unref();
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.onProgress) {
        for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
          options.onProgress(line);
        }
      }
    });
    proc.on('error', (error) => {
      stderr += error.message || String(error);
      finish(1);
    });
    proc.on('close', finish);
  });
}

function missionGoalFromPayload(payload) {
  const mission = payload?.mission || {};
  const goal = payload?.atris_goal_state?.goal || {};
  return {
    objective: goal.objective || mission.objective,
    mission_id: goal.mission_id || mission.id,
    mission_status: goal.mission_status || mission.status,
    runner: goal.runner || mission.runner || 'atris2',
    next_command: goal.next_command || payload?.next_command || mission.next_action,
  };
}

function firstUsefulLine(text, fallback = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\s#]+/, '').trim())
    .filter(Boolean)
    .find((line) => !/^(receipt|summary|final|final answer|result)$/i.test(line))
    || fallback;
}

function lastTickFromRun(runPayload) {
  const ticks = Array.isArray(runPayload?.ticks) ? runPayload.ticks : [];
  return ticks[ticks.length - 1] || null;
}

function workerLine(runPayload) {
  const tick = lastTickFromRun(runPayload);
  if (!tick) return '';
  if (tick.atris2) return firstUsefulLine(tick.atris2.receipt_text, tick.atris2.ok ? 'Atris2 worker ran.' : 'Atris2 worker failed.');
  if (tick.claude) return firstUsefulLine(tick.claude.receipt_text || tick.summary, 'Worker tick recorded.');
  return tick.summary || tick.reason || '';
}

function formatRuntimeMissionLoopReceipt(result) {
  const lines = [];
  const goal = missionGoalFromPayload(result.start?.payload || {});
  if (result.start?.payload) {
    lines.push('Atris mission started');
    lines.push(`Goal: ${goal.objective || '?'}`);
    lines.push(`Mission: ${goal.mission_id || '?'} - ${goal.mission_status || '?'} - ${goal.runner || 'atris2'}`);
  }
  if (result.noRun) {
    lines.push('Pursuing: not run (--no-run)');
    lines.push('Achieved: no');
    if (goal.next_command) lines.push(`Next: ${goal.next_command}`);
    return lines.join('\n');
  }
  lines.push('Atris mission pursued');
  if (result.run?.payload) {
    const ran = Number(result.run.payload.ran_ticks || 0);
    const total = Number(result.run.payload.tick_count || 0);
    lines.push(`Ticks: ${ran}/${total}`);
    const summary = workerLine(result.run.payload);
    if (summary) lines.push(`Work: ${summary}`);
  }
  lines.push(`Achieved: ${result.achieved ? 'yes' : 'no'}`);
  if (result.complete?.payload?.landing?.happened) lines.push(`Landing: ${result.complete.payload.landing.happened}`);
  else if (result.run?.payload?.pause_reason) lines.push(`Blocked: ${result.run.payload.pause_reason}`);
  else if (result.error) lines.push(`Blocked: ${result.error}`);
  const proof = result.complete?.payload?.mission?.proof || result.run?.payload?.summary_receipt || result.start?.payload?.state_path;
  if (proof) lines.push(`Proof: ${proof}`);
  const nextGoal = result.complete?.payload?.continuation_goal?.mission?.objective;
  if (nextGoal) lines.push(`Next goal: ${nextGoal}`);
  const nextCommand = result.complete?.payload?.atris_goal_state?.goal?.next_command || result.run?.payload?.atris_goal_state?.goal?.next_command || goal.next_command;
  if (nextCommand && !nextGoal) lines.push(`Next: ${nextCommand}`);
  return lines.join('\n');
}

async function runRuntimeMissionLoop(intent, options = {}) {
  const cliPath = options.cliPath;
  const cwd = options.cwd || process.cwd();
  if (!cliPath) return { ok: false, status: 1, error: 'missing cliPath', text: 'Blocked: missing cliPath' };
  if (!intent?.objective) return { ok: false, status: 1, error: 'missing objective', text: 'Usage: atris mission run "<objective>"' };

  const startArgs = ['mission', 'run', intent.objective, '--runner', 'atris2', '--owner', intent.owner || 'mission-lead', '--json'];
  if (intent.cadence) startArgs.push('--cadence', intent.cadence);
  const start = runCliJsonSync(cliPath, startArgs, { cwd, timeoutMs: 30000 });
  const result = { ok: start.ok, status: start.status, start, noRun: intent.noRun === true, achieved: false };
  if (!start.ok || !start.payload?.mission?.id) {
    result.error = start.error || start.payload?.error || 'mission start failed';
    result.text = formatRuntimeMissionLoopReceipt(result);
    return result;
  }
  if (intent.noRun) {
    result.text = formatRuntimeMissionLoopReceipt(result);
    return result;
  }

  if (options.onProgress) options.onProgress(`pursuing ${start.payload.mission.id}`);
  const maxWallSeconds = positiveInteger(intent.maxWallSeconds, 600);
  const run = await runCliJsonStreaming(
    cliPath,
    ['mission', 'run', start.payload.mission.id, '--max-ticks', String(positiveInteger(intent.maxTicks, 1)), '--max-wall', String(maxWallSeconds), '--complete-on-pass', '--json'],
    {
      cwd,
      timeoutMs: (maxWallSeconds + 60) * 1000,
      onProgress: options.onProgress,
    },
  );
  result.run = run;
  if (!run.ok) {
    result.ok = false;
    result.status = run.status || 1;
    result.error = run.error || run.payload?.error || 'mission run failed';
    result.text = formatRuntimeMissionLoopReceipt(result);
    return result;
  }

  if (run.payload?.mission?.status === 'complete') {
    result.achieved = true;
    result.ok = true;
    result.text = formatRuntimeMissionLoopReceipt(result);
    return result;
  }

  const mission = run.payload?.mission || {};
  const ranTicks = Number(run.payload?.ran_ticks || 0);
  const proof = run.payload?.summary_receipt || mission.receipt_path;
  if (!intent.noComplete && ranTicks > 0 && !String(mission.verifier || '').trim() && proof) {
    if (options.onProgress) options.onProgress(`landing ${mission.id}`);
    const complete = runCliJsonSync(cliPath, ['mission', 'complete', mission.id, '--proof', proof, '--json'], { cwd, timeoutMs: 30000 });
    result.complete = complete;
    result.achieved = complete.ok && complete.payload?.action === 'mission_completed';
    result.ok = result.achieved;
    if (!complete.ok) result.error = complete.error || complete.payload?.error || 'mission complete failed';
  } else {
    result.ok = false;
    result.error = run.payload?.pause_reason || (ranTicks > 0 ? 'mission still running' : 'no tick proof');
  }
  result.text = formatRuntimeMissionLoopReceipt(result);
  return result;
}

function readAtrisGoalState(cwd = process.cwd()) {
  try {
    const file = path.join(cwd, '.atris', 'state', 'atris_goal.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.goal || null;
  } catch {
    return null;
  }
}

module.exports = {
  missionRunIntentFromMessage,
  runRuntimeMissionLoop,
  formatRuntimeMissionLoopReceipt,
  readAtrisGoalState,
};
