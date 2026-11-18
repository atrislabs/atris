'use strict';

// commands/task/results/results.js: A task's public result: the result card, the accept receipt,
// agent XP, scorecards and the result log.
// Owner: launcher. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read README.md
// first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, path, DEFAULT_OWNER, RESULT_SAVED_TEXT_LIMIT, getTaskDb, flag, wantsJson, printJson, failTask,
  requireResultSentence, textFlag, positional, taskRef, writeDefaultProjection, taskAssignee,
  compactTaskFromProjection, requireTaskId, taskDetail, cleanPublicText, traceLineFromContent,
  latestTraceValue, taskHasTrace, taskPurpose;
function bindMain(deps) {
  ({
    fs, path, DEFAULT_OWNER, RESULT_SAVED_TEXT_LIMIT, getTaskDb, flag, wantsJson, printJson,
    failTask, requireResultSentence, textFlag, positional, taskRef, writeDefaultProjection,
    taskAssignee, compactTaskFromProjection, requireTaskId, taskDetail, cleanPublicText,
    traceLineFromContent, latestTraceValue, taskHasTrace, taskPurpose,
  } = deps);
}

function buildPublicResult(task, fields) {
  const owner = cleanPublicText(
    fields.owner
      || latestTraceValue(task, 'TASK_PLAN_TRACE ', 'owner')
      || taskAssignee(task)
      || task && task.claimed_by
      || fields.actor,
    80,
  );
  const result = {
    purpose: cleanPublicText(fields.purpose || taskPurpose(task), 240),
    owner,
    changed: cleanPublicText(fields.changed, 320),
    checked: cleanPublicText(fields.checked, 320),
    passed: cleanPublicText(fields.passed, 240),
    failed: cleanPublicText(fields.failed, 240),
    cost: cleanPublicText(fields.cost, 80),
    saved: cleanPublicText(fields.saved, RESULT_SAVED_TEXT_LIMIT),
    try_next: cleanPublicText(fields.tryNext, 240),
    status: cleanPublicText(fields.status, 160) || 'ready for review',
  };
  return result;
}

function renderPublicResult(result) {
  return [
    `Changed: ${cleanPublicText(result && result.changed, 320) || 'changed the requested work'}`,
    `Checked: ${cleanPublicText(result && result.checked, 320) || 'checked the result'}`,
    `Try: ${cleanPublicText(result && result.try_next, 240) || 'try the changed work'}`,
  ].join('\n');
}

function latestResultTrace(task) {
  const messages = Array.isArray(task && task.messages) ? task.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = String(messages[i] && messages[i].content || '');
    const line = traceLineFromContent(content, 'TASK_RESULT_TRACE ');
    if (!line) continue;
    try {
      const parsed = JSON.parse(line.slice('TASK_RESULT_TRACE '.length).trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }

  const events = Array.isArray(task && task.events) ? task.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i] && events[i].payload && typeof events[i].payload === 'object'
      ? events[i].payload
      : {};
    if (payload.result_trace && typeof payload.result_trace === 'object') return payload.result_trace;
    const packetLine = traceLineFromContent(payload.result_packet, 'TASK_RESULT_TRACE ');
    if (!packetLine) continue;
    try {
      const parsed = JSON.parse(packetLine.slice('TASK_RESULT_TRACE '.length).trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }
  return null;
}

function buildAcceptHumanResult({ task, proof, nextTask, publicSync }) {
  const trace = latestResultTrace(task) || {};
  const traceChanged = cleanPublicText(trace.changed, 320);
  const changed = traceChanged === 'prepared the work for review'
    ? 'accepted the completed work'
    : traceChanged
    || cleanPublicText(task && task.title, 260)
    || 'accepted the completed work';
  let checked = cleanPublicText(trace.checked, 320)
    || cleanPublicText(proof, 320)
    || 'checked the proof';
  if (publicSync && publicSync.enabled === true && !publicSync.ok) {
    const error = cleanPublicText(publicSync.error || 'publish failed', 140);
    checked = `${checked}; AgentXP publish failed${error ? ` (${error})` : ''}`;
  }
  const tryNext = cleanPublicText(nextTask, 240)
    || cleanPublicText(trace.try_next, 240)
    || 'try the changed work';
  return { changed, checked, try_next: tryNext };
}

function refreshBrainScorecardsAfterAccept(root = process.cwd()) {
  try {
    const { recordTaskEpisodeScorecards } = require('../../../commands/brain');
    return { ok: true, ...recordTaskEpisodeScorecards({ root }) };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function nextMissionRouteAfterAccept(root = process.cwd()) {
  try {
    const { selectCodexGoalMission } = require('../../../commands/mission');
    const selected = selectCodexGoalMission(root);
    const mission = selected && selected.mission;
    if (!mission) return { ok: true, objective: null, route: 'next mission: none' };
    return {
      ok: true,
      mission_id: mission.id,
      objective: mission.objective,
      reason: selected.reason,
      route: `next mission: ${cleanPublicText(mission.objective, 160)}`,
      command: mission.next_action || `atris mission run ${mission.id}`,
    };
  } catch (error) {
    return {
      ok: false,
      route: 'next mission: needs refresh',
      error: error && error.message ? error.message : String(error),
    };
  }
}

function xpLandingText(xpProjection) {
  if (!xpProjection) return 'XP updated';
  if (xpProjection.ok === false) return 'XP refresh failed';
  const candidates = [
    xpProjection.total_agent_xp,
    xpProjection.total_xp,
    xpProjection.summary && xpProjection.summary.total_agent_xp,
    xpProjection.totals && xpProjection.totals.total_agent_xp,
  ];
  const total = candidates.map(Number).find((value) => Number.isFinite(value));
  return Number.isFinite(total) ? `XP updated (${total} total)` : 'XP updated';
}

function brainScorecardLandingText(brainScorecards) {
  if (!brainScorecards) return 'brain scorecards checked';
  if (brainScorecards.ok === false) return 'brain scorecard refresh failed';
  const written = Number(brainScorecards.written);
  return Number.isFinite(written) ? `brain scorecards +${written}` : 'brain scorecards checked';
}

function buildVisibleAcceptReceipt(result, { xpProjection, brainScorecards, nextMissionRoute } = {}) {
  const updates = [
    xpLandingText(xpProjection),
    brainScorecardLandingText(brainScorecards),
  ].filter(Boolean);
  const checked = updates.length ? `${result.checked}; ${updates.join('; ')}` : result.checked;
  const route = cleanPublicText(nextMissionRoute && nextMissionRoute.route, 180);
  const tryNext = route ? `${result.try_next}; ${route}` : result.try_next;
  return { ...result, checked, try_next: tryNext };
}

function renderAcceptLanding({ task, proof, nextTask, publicSync, xpProjection, brainScorecards, nextMissionRoute }) {
  const result = buildAcceptHumanResult({
    task,
    proof,
    nextTask,
    publicSync,
  });
  return renderPublicResult(buildVisibleAcceptReceipt(result, { xpProjection, brainScorecards, nextMissionRoute }));
}

async function publishAcceptAgentXp(args, actor) {
  const token = flag(args, '--token');
  const syncArgs = ['--all', '--root', process.cwd(), '--public', '--as', actor];
  if (typeof token === 'string' && token.trim()) syncArgs.push('--token', token.trim());
  try {
    const { syncAgentXp } = require('../../../commands/xp');
    const result = await syncAgentXp(syncArgs);
    const server = result && result.server ? result.server : {};
    const publicCount = Number(server.public_accepted_count);
    const acceptedCount = Number(server.accepted_count);
    const published = (
      (Number.isFinite(publicCount) && publicCount > 0)
      || (Number.isFinite(acceptedCount) && acceptedCount > 0 && server.private_agentxp !== true)
    );
    return {
      enabled: true,
      ok: published,
      result,
      error: published ? null : 'server accepted no public AgentXP rows',
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function todayResultLogName() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
}

function appendResultOwnerLog(root, task, result) {
  const owner = cleanPublicText(result && result.owner, 80);
  if (!owner || !/^[A-Za-z0-9._-]+$/.test(owner)) return null;
  const memberFile = path.join(root, 'atris', 'team', owner, 'MEMBER.md');
  if (!fs.existsSync(memberFile)) return null;
  const logName = todayResultLogName();
  const logDir = path.join(root, 'atris', 'team', owner, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, logName);
  const stamp = new Date().toTimeString().slice(0, 5);
  const lines = [
    `## ${stamp} - Result`,
    `- task: ${taskRef(task)}`,
    `- purpose: ${result.purpose || ''}`,
    `- result: ${result.changed || ''}`,
    `- checked: ${result.checked || ''}`,
    `- saved: ${result.saved || ''}`,
    `- try: ${result.try_next || ''}`,
    `- status: ${result.status || ''}`,
    '',
  ];
  fs.appendFileSync(logPath, lines.join('\n'), 'utf8');
  return {
    member_log_path: path.relative(root, logPath),
  };
}

function resultTraceData(result, fields) {
  return {
    schema: 'atris.task_result_trace.v1',
    purpose: result.purpose,
    owner: result.owner || null,
    changed: result.changed,
    checked: result.checked,
    passed: result.passed || null,
    failed: result.failed || null,
    cost: result.cost || null,
    saved: result.saved || null,
    try_next: result.try_next || null,
    status: result.status,
    files: cleanPublicText(fields.files, 500) || null,
    commands: cleanPublicText(fields.commands, 500) || null,
    member_log_path: fields.savedPaths && fields.savedPaths.member_log_path || null,
    recorded_at: new Date().toISOString(),
  };
}

function resultTraceNote(result, fields) {
  return `TASK_RESULT_TRACE ${JSON.stringify(resultTraceData(result, fields))}`;
}

function buildAutomaticResultTrace(taskDb, db, taskId, { actor, proof, changed, checked, passed, failed, cost, saved, tryNext, status, files, commands } = {}) {
  const task = taskDetail(taskDb, db, taskId);
  if (!task || taskHasTrace(task, 'TASK_RESULT_TRACE ')) return null;
  const fields = {
    actor,
    changed: cleanPublicText(changed, 320) || 'prepared the work for review',
    checked: cleanPublicText(checked, 320) || cleanPublicText(proof, 320),
    passed: cleanPublicText(passed, 240),
    failed: cleanPublicText(failed, 240),
    cost: cleanPublicText(cost, 80),
    saved: cleanPublicText(saved, RESULT_SAVED_TEXT_LIMIT) || 'task trace was updated',
    tryNext: cleanPublicText(tryNext, 240) || 'review the proof and try the changed work',
    status: cleanPublicText(status, 160) || 'ready for review',
    files,
    commands,
  };
  const result = buildPublicResult(task, fields);
  const savedPaths = appendResultOwnerLog(taskDb.workspaceRoot(), task, result);
  const trace = resultTraceData(result, { ...fields, savedPaths });
  return {
    result,
    trace,
    saved_paths: savedPaths,
  };
}

function cmdResult(args) {
  const pos = positional(args);
  const id = pos[0];
  if (!id) failTask('atris task result', 'missing_id', 'id required');
  const sentence = pos.slice(1).join(' ').trim();
  if (sentence) {
    const resultSentence = requireResultSentence('atris task result', sentence);
    const actor = String(flag(args, '--as') || DEFAULT_OWNER);
    const taskDb = getTaskDb();
    const db = taskDb.open();
    const taskId = requireTaskId(taskDb, db, id, 'atris task result');
    const saved = taskDb.setTaskResult(db, {
      id: taskId,
      actor,
      result: resultSentence,
    });
    if (!saved.saved) failTask('atris task result', saved.reason || 'result_failed', `result failed: ${saved.reason || 'result_failed'}`, 1);
    const { projection, outPath } = writeDefaultProjection(taskDb, db);
    if (wantsJson(args)) {
      printJson({
        ok: true,
        action: 'result',
        task_id: taskId,
        version: saved.event.version,
        result: resultSentence,
        projection_path: outPath,
        task: compactTaskFromProjection(projection, taskId),
      });
      return;
    }
    console.log(`result saved ${taskRef(compactTaskFromProjection(projection, taskId))}: ${resultSentence}`);
    return;
  }
  const fields = {
    purpose: textFlag(args, ['--purpose', '--goal', '--objective']),
    changed: textFlag(args, ['--changed', '--done']),
    checked: textFlag(args, ['--checked', '--check', '--verified']),
    passed: textFlag(args, ['--passed', '--pass']),
    failed: textFlag(args, ['--failed', '--fail']),
    cost: textFlag(args, ['--cost']),
    saved: textFlag(args, ['--saved', '--savings']),
    tryNext: textFlag(args, ['--try', '--try-next', '--handoff']),
    status: textFlag(args, ['--status']),
    files: textFlag(args, ['--files']),
    commands: textFlag(args, ['--commands', '--command']),
  };
  if (!fields.changed) failTask('atris task result', 'changed_required', '--changed required');
  if (!fields.checked) failTask('atris task result', 'checked_required', '--checked required');
  if (!fields.tryNext) failTask('atris task result', 'try_required', '--try required');
  const actor = String(flag(args, '--as') || DEFAULT_OWNER);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const taskId = requireTaskId(taskDb, db, id, 'atris task result');
  const task = taskDetail(taskDb, db, taskId);
  if (!task) failTask('atris task result', 'not_found', `task not found: ${id}`, 1);
  const result = buildPublicResult(task, { ...fields, actor });
  const savedPaths = appendResultOwnerLog(taskDb.workspaceRoot(), task, result);
  const note = taskDb.noteTask(db, {
    id: taskId,
    actor,
    content: resultTraceNote(result, { ...fields, savedPaths }),
  });
  if (!note.noted) failTask('atris task result', note.reason || 'note_failed', `result failed: ${note.reason || 'note_failed'}`, 1);
  const { projection, outPath } = writeDefaultProjection(taskDb, db);
  const text = renderPublicResult(result);
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'result',
      task_id: taskId,
      version: note.event.version,
      projection_path: outPath,
      result,
      saved_paths: savedPaths,
      text,
      task: compactTaskFromProjection(projection, taskId),
    });
    return;
  }
  console.log(text);
}

module.exports = {
  bindMain, buildPublicResult, renderPublicResult, latestResultTrace, buildAcceptHumanResult,
  refreshBrainScorecardsAfterAccept, nextMissionRouteAfterAccept, xpLandingText,
  brainScorecardLandingText, buildVisibleAcceptReceipt, renderAcceptLanding, publishAcceptAgentXp,
  todayResultLogName, appendResultOwnerLog, resultTraceData, resultTraceNote,
  buildAutomaticResultTrace, cmdResult,
};
