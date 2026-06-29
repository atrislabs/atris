'use strict';

const fs = require('fs');
const path = require('path');

const ACTIVE_MISSION_STATUSES = new Set(['planning', 'running', 'ready']);

function hasFlag(args, name) {
  return args.includes(name);
}

function readFlag(args, name, fallback = '') {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) return String(args[i + 1]);
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function inferActor() {
  if (process.env.ATRIS_AGENT_ID) return process.env.ATRIS_AGENT_ID;
  if (process.env.CODEX_SANDBOX) return 'codex';
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (process.env.CURSOR_AGENT) return 'cursor';
  if (process.env.DEVIN_SESSION_ID) return 'devin';
  return process.env.USER || 'operator';
}

function clip(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function taskRef(task) {
  return task && (task.display_id || task.legacy_ref || task.id) || '';
}

function taskUpdatedAt(task) {
  return Number(task && task.updated_at || task && task.created_at || 0);
}

function taskReview(task) {
  return task && (task.review || task.metadata || {}) || {};
}

function taskAgentReviewPasses(task) {
  const review = taskReview(task);
  return Number(review.agent_review_pass_count || 0);
}

function taskIsAgentCertified(task) {
  const review = taskReview(task);
  return review.agent_certified === true || taskAgentReviewPasses(task) >= 2;
}

function taskNeedsAgentReview(task) {
  if (!task || task.status !== 'review') return false;
  return !taskIsAgentCertified(task);
}

function taskIsHumanGatedClaimed(task) {
  if (!task || task.status !== 'claimed') return false;
  const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const text = [
    task.title,
    metadata.exit_condition,
    metadata.verify,
    metadata.proof_needed,
    metadata.task_goal,
    metadata.goal_objective,
    metadata.stage_goal,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (/\bafter approval\b/i.test(text)) return true;
  return /\b(human|operator)\b/i.test(text)
    && /\b(accept|approval|approve|confirm|choose|chooses|chosen|install|publish|release)\b/i.test(text);
}

function taskIsOwnedByActor(task, actor) {
  return String(task && task.claimed_by || '').toLowerCase() === String(actor || '').toLowerCase();
}

function taskReviewCommand(task) {
  const review = task && task.review || {};
  const verificationChat = review.verification_chat || {};
  return verificationChat.command || `atris task review-chat ${taskRef(task)} --as codex-review`;
}

function newest(tasks) {
  return [...tasks].sort((a, b) => taskUpdatedAt(b) - taskUpdatedAt(a))[0] || null;
}

function summarizeTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const counts = {
    open: 0,
    claimed: 0,
    review: 0,
    review_needs_agent: 0,
    review_certified: 0,
    failed: 0,
    done_visible: 0,
  };
  for (const task of list) {
    if (task.status === 'open') counts.open += 1;
    else if (task.status === 'claimed') counts.claimed += 1;
    else if (task.status === 'review') {
      counts.review += 1;
      if (taskNeedsAgentReview(task)) counts.review_needs_agent += 1;
      if (taskIsAgentCertified(task)) counts.review_certified += 1;
    } else if (task.status === 'failed') counts.failed += 1;
    else if (task.status === 'done') counts.done_visible += 1;
  }
  return counts;
}

function latestMissions(root) {
  const file = path.join(root, '.atris', 'state', 'missions.jsonl');
  const byId = new Map();
  for (const record of readJsonLines(file)) {
    const id = record.id || record.mission_id;
    if (!id) continue;
    byId.set(id, { ...record, id });
  }
  return [...byId.values()].filter(mission => ACTIVE_MISSION_STATUSES.has(String(mission.status || '')));
}

function missionNeedsTick(mission) {
  if (!mission) return false;
  const passed = mission.verifier_result && mission.verifier_result.passed === true;
  return Boolean(mission.verifier) && !passed;
}

function readBrain(root) {
  const statusPath = path.join(root, 'atris', 'brain', 'STATUS.md');
  const status = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : '';
  const nextMoveMatch = status.match(/## Next Move\s+([\s\S]*?)(?:\n## |\n# |$)/);
  const nextMove = nextMoveMatch
    ? nextMoveMatch[1].split(/\r?\n/).map(line => line.replace(/^[-\s]+/, '').trim()).find(Boolean) || ''
    : '';
  return {
    status_path: fs.existsSync(statusPath) ? path.relative(root, statusPath) : null,
    next_move: nextMove || null,
  };
}

function readEndgame(root) {
  const todoPath = path.join(root, 'atris', 'TODO.md');
  if (!fs.existsSync(todoPath)) return null;
  const text = fs.readFileSync(todoPath, 'utf8');
  const slug = (text.match(/\*\*Slug:\*\*\s*([^\n]+)/) || [])[1];
  const horizon = (text.match(/\*\*Horizon:\*\*\s*([^\n]+)/) || [])[1];
  if (!slug && !horizon) return null;
  return {
    slug: slug ? slug.trim() : null,
    horizon: horizon ? horizon.trim() : null,
  };
}

function loadTaskProjection(root) {
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  const projection = readJson(projectionPath);
  return {
    projection_path: fs.existsSync(projectionPath) ? path.relative(root, projectionPath) : null,
    projection,
    tasks: projection && Array.isArray(projection.tasks) ? projection.tasks : [],
    hidden_done_count: Number(projection && projection.surface && projection.surface.hidden_done_count || 0),
  };
}

function chooseNextAction({ root, actor, tasks, missions, brain, endgame }) {
  if (!fs.existsSync(path.join(root, 'atris'))) {
    return {
      kind: 'bootstrap',
      label: 'Initialize this workspace',
      command: 'atris init',
      why: 'No atris/ directory exists yet.',
    };
  }

  const ownClaimed = newest(tasks.filter(task => (
    task.status === 'claimed'
    && taskIsOwnedByActor(task, actor)
  )));
  if (ownClaimed) {
    return {
      kind: 'continue_claimed_task',
      label: `${taskRef(ownClaimed)} ${clip(ownClaimed.title, 90)}`,
      command: `atris task step ${taskRef(ownClaimed)}`,
      why: `${actor} already owns claimed work; finish or move it to Review before starting more.`,
      task: compactTask(ownClaimed),
    };
  }

  const mission = missions.find(missionNeedsTick);
  if (mission) {
    return {
      kind: 'tick_mission',
      label: clip(mission.objective || mission.id, 100),
      command: `atris mission tick ${mission.id} --verify --complete-on-pass`,
      why: 'A live mission has a verifier that has not passed yet.',
      mission: compactMission(mission),
    };
  }

  const reviewTask = newest(tasks.filter(taskNeedsAgentReview));
  if (reviewTask) {
    return {
      kind: 'review_proof',
      label: `${taskRef(reviewTask)} ${clip(reviewTask.title, 90)}`,
      command: taskReviewCommand(reviewTask),
      why: 'Review contains proof that still needs an agent verification pass.',
      task: compactTask(reviewTask),
    };
  }

  const certifiedReview = newest(tasks.filter(task => task.status === 'review' && taskIsAgentCertified(task)));
  if (certifiedReview) {
    return {
      kind: 'human_accept_queue',
      label: `${taskRef(certifiedReview)} ${clip(certifiedReview.title, 90)}`,
      command: 'atris task reviews --limit 5',
      why: 'Certified proof is waiting for human accept; agents should not accept XP.',
      task: compactTask(certifiedReview),
    };
  }

  const openTask = newest(tasks.filter(task => task.status === 'open'));
  if (openTask) {
    return {
      kind: 'claim_open_task',
      label: `${taskRef(openTask)} ${clip(openTask.title, 90)}`,
      command: `atris task claim ${taskRef(openTask)} --as ${actor}`,
      why: 'Open task is ready to claim.',
      task: compactTask(openTask),
    };
  }

  if (endgame && endgame.slug) {
    return {
      kind: 'seed_endgame_task',
      label: endgame.slug,
      command: 'atris task next --create-next',
      why: 'No actionable task is open, but TODO has an Endgame horizon.',
      endgame,
    };
  }

  if (brain && brain.next_move) {
    return {
      kind: 'activate_brain',
      label: clip(brain.next_move, 100),
      command: 'atris brain activate --root . --verify',
      why: 'No task or mission outranks the compiled brain next move.',
    };
  }

  return {
    kind: 'ask_for_work',
    label: 'Ask for the next concrete outcome',
    command: 'atris',
    why: 'No task, mission, endgame, or brain next move is available.',
  };
}

function compactTask(task) {
  if (!task) return null;
  const review = task.review || {};
  return {
    ref: taskRef(task),
    title: task.title || '',
    status: task.status || '',
    tag: task.tag || null,
    claimed_by: task.claimed_by || null,
    agent_review_pass_count: Number(review.agent_review_pass_count || task.metadata && task.metadata.agent_review_pass_count || 0),
    agent_certified: taskIsAgentCertified(task),
  };
}

function compactMission(mission) {
  if (!mission) return null;
  return {
    id: mission.id,
    owner: mission.owner || null,
    status: mission.status || null,
    objective: mission.objective || '',
    verifier: mission.verifier || null,
  };
}

function sortNewest(items) {
  return [...items].sort((a, b) => taskUpdatedAt(b) - taskUpdatedAt(a));
}

function taskSuggestion({ title, task, why }) {
  return {
    title,
    subject: task && task.title || '',
    ref: taskRef(task) || null,
    why,
  };
}

function missionSuggestion(mission) {
  return {
    title: 'Run the paused live job',
    subject: mission && mission.objective || '',
    ref: mission && mission.id || null,
    why: 'It is waiting on a check before it can move forward.',
  };
}

function endgameSuggestion(endgame) {
  return {
    title: 'Turn the goal into a small first task',
    subject: endgame && (endgame.horizon || endgame.slug) || '',
    ref: endgame && endgame.slug || null,
    why: 'The goal exists, but no one has a concrete first move yet.',
  };
}

function brainSuggestion(brain) {
  return {
    title: 'Use the saved next move',
    subject: brain && brain.next_move || '',
    ref: null,
    why: 'There is no more urgent work item in the queue.',
  };
}

function pushSuggestion(list, seen, suggestion) {
  if (!suggestion || !suggestion.subject) return;
  const key = `${suggestion.title}:${suggestion.subject}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({
    ...suggestion,
    subject: clip(suggestion.subject, 68),
    why: clip(suggestion.why, 86),
  });
}

function suggestedNextMoves({ actor, tasks, missions, brain, endgame }) {
  const suggestions = [];
  const seen = new Set();
  const actorKey = String(actor || '').toLowerCase();

  const ownClaimed = sortNewest(tasks.filter(item => (
    item.status === 'claimed'
    && String(item.claimed_by || '').toLowerCase() === actorKey
  ))).slice(0, 2);
  ownClaimed.forEach((task, index) => {
    pushSuggestion(suggestions, seen, taskSuggestion({
      title: index === 0 ? 'Finish current work' : 'Close another open thread',
      task,
      why: 'It is already in progress, so finishing it avoids another loose thread.',
    }));
  });

  const mission = missions.find(missionNeedsTick);
  if (mission) pushSuggestion(suggestions, seen, missionSuggestion(mission));

  const reviewTask = newest(tasks.filter(taskNeedsAgentReview));
  if (reviewTask) {
    pushSuggestion(suggestions, seen, taskSuggestion({
      title: 'Check a finished change',
      task: reviewTask,
      why: 'It is built, but it needs a second set of eyes before anyone trusts it.',
    }));
  }

  const certifiedReview = newest(tasks.filter(task => task.status === 'review' && taskIsAgentCertified(task)));
  if (certifiedReview) {
    pushSuggestion(suggestions, seen, taskSuggestion({
      title: 'Approve or send back checked work',
      task: certifiedReview,
      why: 'It has already been checked and is waiting for a human decision.',
    }));
  }

  const openTask = newest(tasks.filter(task => task.status === 'open'));
  if (openTask) {
    pushSuggestion(suggestions, seen, taskSuggestion({
      title: 'Start new work',
      task: openTask,
      why: 'It is unowned and ready for someone to pick up.',
    }));
  }

  if (endgame && endgame.slug) pushSuggestion(suggestions, seen, endgameSuggestion(endgame));
  if (brain && brain.next_move) pushSuggestion(suggestions, seen, brainSuggestion(brain));

  return suggestions.slice(0, 3);
}

function collectLaunchpad(root = process.cwd(), args = []) {
  const actor = readFlag(args, '--as', inferActor());
  const taskState = loadTaskProjection(root);
  const skippedCurrent = newest(taskState.tasks.filter(task => (
    taskIsOwnedByActor(task, actor)
    && taskIsHumanGatedClaimed(task)
  )));
  const actionableTasks = skippedCurrent
    ? taskState.tasks.filter(task => task.id !== skippedCurrent.id)
    : taskState.tasks;
  const missions = latestMissions(root);
  const brain = readBrain(root);
  const endgame = readEndgame(root);
  const counts = summarizeTasks(taskState.tasks);
  counts.missions_active = missions.length;
  counts.missions_need_tick = missions.filter(missionNeedsTick).length;
  counts.hidden_done = taskState.hidden_done_count;

  const nextAction = chooseNextAction({
    root,
    actor,
    tasks: actionableTasks,
    missions,
    brain,
    endgame,
  });
  if (skippedCurrent) nextAction.skipped_current = compactTask(skippedCurrent);

  return {
    ok: true,
    schema: 'atris.launchpad.v1',
    workspace_root: root,
    workspace: path.basename(root),
    actor,
    counts,
    skipped_current: skippedCurrent ? compactTask(skippedCurrent) : null,
    next_action: nextAction,
    suggestions: suggestedNextMoves({
      actor,
      tasks: actionableTasks,
      missions,
      brain,
      endgame,
    }),
    previews: {
      claimed: taskState.tasks.filter(task => task.status === 'claimed').slice(0, 5).map(compactTask),
      review: taskState.tasks.filter(task => task.status === 'review').slice(0, 5).map(compactTask),
      open: taskState.tasks.filter(task => task.status === 'open').slice(0, 5).map(compactTask),
      missions: missions.slice(0, 5).map(compactMission),
    },
    brain,
    endgame,
    sources: {
      tasks: taskState.projection_path,
      missions: fs.existsSync(path.join(root, '.atris', 'state', 'missions.jsonl')) ? '.atris/state/missions.jsonl' : null,
      brain: brain.status_path,
      todo: fs.existsSync(path.join(root, 'atris', 'TODO.md')) ? 'atris/TODO.md' : null,
    },
  };
}

function actionTitle(action) {
  const kind = action && action.kind;
  if (kind === 'continue_claimed_task') return 'Work in progress';
  if (kind === 'tick_mission') return 'Live job waiting on a check';
  if (kind === 'review_proof') return 'Built change waiting for a check';
  if (kind === 'human_accept_queue') return 'Checked change waiting for your approval';
  if (kind === 'claim_open_task') return 'New change ready to start';
  if (kind === 'seed_endgame_task') return 'Goal needs a first task';
  if (kind === 'activate_brain') return 'Saved next move is ready';
  if (kind === 'bootstrap') return 'Set up this workspace';
  return 'No clear next move';
}

function whatHappened(action) {
  const kind = action && action.kind;
  if (kind === 'continue_claimed_task') return 'This change is already yours. Finish it before starting another.';
  if (kind === 'tick_mission') return 'An always-on job is paused until its check runs.';
  if (kind === 'review_proof') return 'This change is built. It needs someone else to check it before it counts as done.';
  if (kind === 'human_accept_queue') return 'This change has been checked. It is waiting for your yes or no.';
  if (kind === 'claim_open_task') return 'This change has not been started yet.';
  if (kind === 'seed_endgame_task') return 'There is a goal, but no small first step exists yet.';
  if (kind === 'activate_brain') return 'There is no urgent work item, so Atris is falling back to the saved next move.';
  if (kind === 'bootstrap') return 'Atris is not set up in this folder yet.';
  return action && action.why || 'No clear next move was found.';
}

function afterThis(action) {
  const kind = action && action.kind;
  if (kind === 'continue_claimed_task') return 'When it is ready, send it for a check.';
  if (kind === 'tick_mission') return 'If the check passes, the job can close or move on.';
  if (kind === 'review_proof') return 'If the check passes, you can approve it. If not, it comes back with the fix needed.';
  if (kind === 'human_accept_queue') return 'Approve it if you trust it. Send it back if something feels off.';
  if (kind === 'claim_open_task') return 'After claiming it, Atris will walk the change forward.';
  if (kind === 'seed_endgame_task') return 'After the task exists, an agent can claim and build it.';
  if (kind === 'activate_brain') return 'Atris will reload the saved context and pick from there.';
  if (kind === 'bootstrap') return 'After setup, run atris again.';
  return 'Then rerun atris launchpad.';
}

function humanSubject(action) {
  if (action && action.task) {
    const ref = action.task.ref ? ` (${action.task.ref})` : '';
    return `${clip(action.task.title || action.label, 68)}${ref}`;
  }
  if (action && action.mission) return clip(action.mission.objective || action.label, 76);
  if (action && action.endgame) return clip(action.endgame.horizon || action.endgame.slug, 76);
  return clip(action && action.label || 'No item selected', 76);
}

function behindLines(payload) {
  const counts = payload.counts || {};
  const reviewNeedsAgent = counts.review_needs_agent || 0;
  const reviewReadyForHuman = counts.review_certified || 0;
  const claimed = counts.claimed || 0;
  const missions = counts.missions_need_tick || 0;
  const lines = [];
  if (reviewNeedsAgent) lines.push(`${reviewNeedsAgent} built change${reviewNeedsAgent === 1 ? ' still needs' : 's still need'} a check`);
  if (reviewReadyForHuman) lines.push(`${reviewReadyForHuman} checked change${reviewReadyForHuman === 1 ? ' is' : 's are'} waiting for you`);
  if (claimed) lines.push(`${claimed} change${claimed === 1 ? ' is' : 's are'} still in progress`);
  if (missions) lines.push(`${missions} live job${missions === 1 ? ' is' : 's are'} waiting on a check`);
  if (!lines.length) lines.push('Nothing urgent is waiting');
  return lines.slice(0, 4);
}

function suggestionLines(suggestions) {
  const list = Array.isArray(suggestions) ? suggestions.filter(item => item && item.subject) : [];
  if (!list.length) {
    return [
      '  1. Pick one clear outcome',
      '     No waiting work was found.',
      '     Say what you want moved forward and Atris can turn it into a task.',
    ];
  }
  return list.flatMap((item, index) => {
    const ref = item.ref && !String(item.subject).includes(String(item.ref)) ? ` (${item.ref})` : '';
    return [
      `  ${index + 1}. ${clip(item.title, 48)}`,
      `     ${clip(item.subject, 64)}${ref}`,
      `     ${clip(item.why, 86)}`,
    ];
  });
}

function boxLine(text, width = 62) {
  const clipped = clip(text, width - 4);
  return `| ${clipped.padEnd(width - 4)} |`;
}

function renderLaunchpad(payload) {
  const next = payload.next_action || {};
  const title = actionTitle(next);
  const subject = humanSubject(next);
  const command = next.command || 'atris';
  const happened = whatHappened(next);
  const after = afterThis(next);
  const behind = behindLines(payload);
  const lines = [
    '',
    '+------------------------------------------------------------+',
    boxLine('ATRIS'),
    boxLine(title),
    '+------------------------------------------------------------+',
    '',
    'WHAT HAPPENED',
    `  ${subject}`,
    `  ${happened}`,
    '',
    'WHAT TO WORK ON NEXT',
    ...suggestionLines(payload.suggestions),
    '',
    'RUN THIS',
    `      ${command}`,
    '',
    'AFTER THAT',
    `  ${after}`,
    '',
    'BEHIND THIS',
    ...behind.map(item => `  - ${item}`),
  ];
  return `${lines.join('\n')}\n`;
}

function showLaunchpadHelp() {
  console.log('Usage: atris launchpad [--json] [--as <owner>]');
  console.log('');
  console.log('Show one compact command-center card from local brain, task, mission, and proof state.');
  console.log('');
  console.log('Options:');
  console.log('  --json        Print machine-readable launchpad state.');
  console.log('  --as <owner>  Pick next action for a specific agent/member.');
  console.log('  --help, -h    Show this help.');
}

function launchpadCommand(args = []) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    showLaunchpadHelp();
    return 0;
  }
  const payload = collectLaunchpad(process.cwd(), args);
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    process.stdout.write(renderLaunchpad(payload));
  }
  return 0;
}

module.exports = {
  collectLaunchpad,
  launchpadCommand,
  renderLaunchpad,
};
