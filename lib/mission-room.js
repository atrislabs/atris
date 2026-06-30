'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STOP_WORDS = new Set([
  'a',
  'able',
  'about',
  'after',
  'again',
  'all',
  'also',
  'am',
  'an',
  'and',
  'are',
  'as',
  'at',
  'atris',
  'be',
  'become',
  'because',
  'but',
  'by',
  'can',
  'cant',
  'could',
  'day',
  'days',
  'do',
  'done',
  'dont',
  'everything',
  'for',
  'from',
  'get',
  'got',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'led',
  'like',
  'make',
  'me',
  'mission',
  'my',
  'need',
  'not',
  'now',
  'of',
  'on',
  'one',
  'or',
  'our',
  'out',
  'place',
  'reference',
  'room',
  'select',
  'selected',
  'should',
  'so',
  'suggest',
  'suggested',
  'suggests',
  'that',
  'the',
  'this',
  'to',
  'too',
  'turn',
  'up',
  'us',
  'we',
  'what',
  'when',
  'with',
  'without',
  'want',
  'wants',
  'why',
  'where',
]);

const PRIORITY_TERMS = new Map([
  ['member', 122],
  ['members', 122],
  ['log', 120],
  ['logs', 120],
  ['context', 118],
  ['proactive', 116],
  ['thinking', 115],
  ['approval', 110],
  ['approve', 108],
  ['operator', 106],
  ['next', 105],
  ['clarify', 104],
  ['clarifies', 104],
  ['proof', 100],
  ['runway', 100],
  ['cash', 95],
  ['revenue', 90],
  ['goals', 88],
  ['goal', 88],
  ['bounded', 86],
  ['product', 85],
  ['growth', 80],
  ['wedge', 78],
  ['proof', 75],
  ['receipt', 72],
  ['customer', 70],
  ['buyer', 68],
  ['launch', 66],
  ['activation', 64],
  ['share', 62],
  ['invite', 60],
  ['agent', 58],
  ['agents', 58],
]);

const PROCESS_NAMING_TERMS = new Set([
  'approval',
  'approve',
  'clarify',
  'context',
  'goal',
  'log',
  'member',
  'next',
  'operator',
  'receipt',
  'thinking',
]);

function normalizeInput(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return String(value || 'mission-room')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'mission-room';
}

function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function keywordTerms(input) {
  const counts = new Map();
  const firstIndex = new Map();
  for (const match of normalizeInput(input).toLowerCase().matchAll(/[a-z0-9][a-z0-9'-]{2,}/g)) {
    const parts = match[0].split(/[-']/).filter(Boolean);
    for (const part of parts) {
      let word = part.replace(/[^a-z0-9]/g, '');
      if (word === 'approve' || word === 'approved' || word === 'approves') word = 'approval';
      if (word === 'goals') word = 'goal';
      if (word === 'members') word = 'member';
      if (word === 'logs') word = 'log';
      if (word === 'clarifies' || word === 'clarified') word = 'clarify';
      if (!word || STOP_WORDS.has(word)) continue;
      if (!firstIndex.has(word)) firstIndex.set(word, match.index);
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => {
      const scoreA = (PRIORITY_TERMS.get(a[0]) || 0) + (a[1] * 10);
      const scoreB = (PRIORITY_TERMS.get(b[0]) || 0) + (b[1] * 10);
      return scoreB - scoreA || firstIndex.get(a[0]) - firstIndex.get(b[0]) || a[0].localeCompare(b[0]);
    })
    .map(([word]) => word)
    .slice(0, 4);
}

function sentenceExcerpt(input, max = 220) {
  const normalized = normalizeInput(input);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).replace(/\s+\S*$/, '')}...`;
}

function hasWord(input, words) {
  return words.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(input));
}

function missionName(input) {
  const normalized = normalizeInput(input);
  const lower = normalized.toLowerCase();
  const asksForNextMission = /\b(decide|pick|choose|select|start|find)\b.{0,120}\bnext\b.{0,80}\bmission\b/i.test(lower)
    || /\bnext\s+useful\s+mission\b/i.test(lower);
  const hasRunway = hasWord(lower, ['runway']);
  const hasProductLed = /\bproduct[-\s]+led\b/i.test(lower)
    || (hasWord(lower, ['product']) && hasWord(lower, ['growth', 'wedge', 'adoption']));
  const hasCashSignal = hasWord(lower, ['cash', 'revenue', 'payment', 'paid', 'buyer', 'customer', 'adoption']);
  const hasProofSignal = hasWord(lower, ['proof', 'demo', 'artifact', 'validate', 'validated']);

  if (asksForNextMission) return 'Decide Next Useful Mission Room';
  if (hasRunway && hasProductLed && (hasCashSignal || hasProofSignal)) return 'Ship Product-Led Cash Proof Mission Room';
  if (hasRunway && hasProductLed) return 'Ship Product-Led Runway Proof Mission Room';
  if ((hasRunway || hasCashSignal) && hasProofSignal) return 'Ship Cash Proof Mission Room';
  if (/\bwarm\s+buyer\b/i.test(lower) && hasWord(lower, ['loop', 'loops', 'waste'])) return 'Replace Warm Buyer Loops Mission Room';

  const rawTerms = keywordTerms(input);
  if (rawTerms.includes('thinking') && rawTerms.includes('approval')) return 'Thinking Approval Mission Room';
  const terms = rawTerms.filter((term) => !PROCESS_NAMING_TERMS.has(term));
  if (!terms.length) return 'Clarity Mission Room';
  return `${titleCase(terms.slice(0, 3).join(' '))} Mission Room`;
}

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function relativePath(root, absolutePath) {
  return toPosixPath(path.relative(root, absolutePath));
}

function readFileExcerpt(filePath, max = 180) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  let body = '';
  try {
    body = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
  const line = body
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
    .filter((row) => !row.startsWith('<!--'))
    .find((row) => row.startsWith('#') || row.startsWith('- ') || row.length > 20)
    || '';
  return sentenceExcerpt(line.replace(/^#+\s*/, '').replace(/^-\s*/, ''), max);
}

function fileSignal(root, filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return {
    label,
    path: relativePath(root, filePath),
    excerpt: readFileExcerpt(filePath),
  };
}

function listTeamMembers(root) {
  const teamDir = path.join(root, 'atris', 'team');
  try {
    return fs.readdirSync(teamDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== '_template')
      .filter((name) => fs.existsSync(path.join(teamDir, name, 'MEMBER.md')))
      .sort();
  } catch (_) {
    return [];
  }
}

function listMarkdownFiles(dir, limit = 200) {
  const found = [];
  function visit(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch (_) {
        continue;
      }
      found.push({ path: fullPath, mtimeMs: stat.mtimeMs });
    }
  }
  visit(dir);
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((row) => row.path);
}

function latestMarkdownFile(dir) {
  return listMarkdownFiles(dir, 1)[0] || null;
}

function buildClarifyingQuestions() {
  return [
    {
      id: 'done_standard',
      question: 'What would make this mission undeniably done for you?',
      why: 'Defines the approval threshold before Atris starts running goals.',
    },
    {
      id: 'approval_boundary',
      question: 'Which decisions can Atris make alone, and which ones must wait for your approval?',
      why: 'Keeps your role at judgment, priority, and final accept instead of task execution.',
    },
    {
      id: 'first_trusted_proof',
      question: 'What first proof would you trust: changed file, test, screenshot, customer signal, payment, or receipt?',
      why: 'Prevents goal loops from becoming motion without evidence.',
    },
  ];
}

function buildApprovalPacket(name, summary, owner) {
  const approvedCommand = `atris mission start "${name}" --owner ${owner} --runner codex_goal --lane code --verify "<cmd>" --xp-task`;
  return {
    status: 'awaiting_operator_approval',
    approve_question: `Approve ${name} as the mission?`,
    operator_role: 'Approve taste, judgment, priority, and final accept; Atris owns bounded execution and proof receipts.',
    proposed_mission: name,
    proposed_outcome: `A proof-backed mission that resolves: ${summary}`,
    approval_standard: [
      'The mission is easy to explain in one sentence.',
      'The first proof step is inspectable by the operator.',
      'Every next goal must produce a receipt, ask for approval, or stop.',
    ],
    decision_options: ['approve', 'revise', 'stop'],
    approved_next_command: approvedCommand,
  };
}

function buildGoalChain(name) {
  return {
    mode: 'approval_gated',
    loop: 'clarify -> approve packet -> set one goal -> prove -> receipt -> approve/revise/next goal',
    first_goal: `Prove ${name} with the smallest inspectable receipt.`,
    next_goal_policy: 'Set exactly one next goal after each receipt; stop when proof is strong enough for operator approval or a real blocker appears.',
    stop_conditions: [
      'operator rejects the approval packet',
      'verifier fails and cannot be repaired inside the current goal',
      'the next step requires taste, priority, budget, or customer judgment',
      'the mission reaches an inspectable delivery receipt',
    ],
  };
}

function thinkingPath(root = process.cwd()) {
  return {
    relativePath: path.join('atris', 'thinking.md'),
    absolutePath: path.join(root, 'atris', 'thinking.md'),
  };
}

function defaultThinkingBody() {
  return [
    '# thinking.md',
    '',
    '<!-- Human-editable. Mission Room updates this with how the operator thinks, decides, approves, rejects, prioritizes, and explains. -->',
    '',
    '## What This File Is',
    '',
    'Team logs say what happened.',
    '',
    'This file says how Keshav thinks.',
    '',
    '## How Keshav Thinks',
    '',
    '- Starts from messy truth, then wants it clarified into a mission he can approve or reject.',
    '- Values plain English, no jargon, and proof over motion.',
    '- Wants Atris to raise his role from doing tasks to judging taste, priority, and final accept.',
    '',
    '## Approval Rules',
    '',
    '- Atris can clarify, propose, run bounded proof steps, and write receipts.',
    '- Keshav keeps taste, judgment, priority, budget, customer calls, and final accept.',
    '- Real-world side effects wait for approval unless the mission explicitly grants permission.',
    '',
    '## Proof Standards',
    '',
    '- Every goal needs a receipt, verifier, visible artifact, or stop reason.',
    '- A good receipt is easy to inspect and easy to explain.',
    '- A goal chain stops when proof is strong enough for approval or a real blocker appears.',
    '',
    '## Mission Room Signals',
    '',
    '<!-- ATRIS_MISSION_ROOM_SIGNALS:START -->',
    '<!-- ATRIS_MISSION_ROOM_SIGNALS:END -->',
    '',
  ].join('\n');
}

function upsertSignal(body, line) {
  const start = '<!-- ATRIS_MISSION_ROOM_SIGNALS:START -->';
  const end = '<!-- ATRIS_MISSION_ROOM_SIGNALS:END -->';
  if (!body.includes(start) || !body.includes(end)) {
    const base = body.trimEnd();
    return `${base}\n\n## Mission Room Signals\n\n${start}\n${line}\n${end}\n`;
  }
  if (body.includes(line)) return body;
  return body.replace(end, `${line}\n${end}`);
}

function writeThinkingMemory(room, options = {}) {
  const root = options.root || process.cwd();
  const at = options.at || new Date();
  const { relativePath, absolutePath } = thinkingPath(root);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const source = sentenceExcerpt(room.truth_snapshot || room.source?.excerpt || room.name, 180);
  const signal = `- ${at.toISOString()} - ${room.name}: ${source}`;
  const before = fs.existsSync(absolutePath)
    ? fs.readFileSync(absolutePath, 'utf8')
    : defaultThinkingBody();
  const after = upsertSignal(before, signal);
  fs.writeFileSync(absolutePath, after.endsWith('\n') ? after : `${after}\n`, 'utf8');

  return {
    path: relativePath,
    updated: true,
    latest_signal: signal,
    purpose: 'how Keshav thinks, decides, approves, rejects, prioritizes, and explains.',
  };
}

function collectMissionRoomContext(input, options = {}) {
  const root = options.root || process.cwd();
  const owner = options.owner || 'mission-lead';
  const ownerResolution = options.ownerResolution || null;
  const members = listTeamMembers(root);
  const memberRoot = path.join(root, 'atris', 'team', owner);
  const memberFile = path.join(memberRoot, 'MEMBER.md');
  const memberExists = fs.existsSync(memberFile);
  const latestMemberLog = memberExists ? latestMarkdownFile(path.join(memberRoot, 'logs')) : null;
  const latestWorkspaceLog = latestMarkdownFile(path.join(root, 'atris', 'logs'));
  const { relativePath: thinkingRelative, absolutePath: thinkingAbsolute } = thinkingPath(root);

  const memberFiles = [
    fileSignal(root, memberFile, 'member'),
    fileSignal(root, path.join(memberRoot, 'MISSION.md'), 'mission'),
    fileSignal(root, path.join(memberRoot, 'now.md'), 'now'),
    fileSignal(root, latestMemberLog, 'member_log'),
  ].filter(Boolean);

  const memberStatus = memberExists
    ? 'member_selected'
    : members.length
      ? 'selected_member_missing'
      : 'no_members_task_first';

  return {
    schema: 'atris.mission_room_context.v1',
    selected_member: owner,
    selection_reason: ownerResolution?.reason || (memberExists ? 'selected_member' : memberStatus),
    proposed_member: ownerResolution?.proposed_member || null,
    available_members: members,
    member_context: {
      status: memberStatus,
      member_exists: memberExists,
      guidance: memberExists
        ? 'Read this member, now.md, mission file, and latest log before starting the mission.'
        : 'No matching MEMBER.md is available; reason from the task first, then create or select the member before autonomous execution.',
      files: memberFiles,
    },
    memory_context: {
      thinking: {
        path: thinkingRelative,
        exists: fs.existsSync(thinkingAbsolute),
        purpose: 'operator judgment, approval rules, proof standards, and recurring mission signals.',
        excerpt: readFileExcerpt(thinkingAbsolute),
      },
      workspace_log: fileSignal(root, latestWorkspaceLog, 'workspace_log'),
    },
    task_first_summary: sentenceExcerpt(input, 180),
  };
}

function contextPaths(context) {
  const paths = [];
  for (const file of context?.member_context?.files || []) {
    if (file?.path) paths.push(file.path);
  }
  const thinking = context?.memory_context?.thinking;
  if (thinking?.path) paths.push(thinking.path);
  const workspaceLog = context?.memory_context?.workspace_log;
  if (workspaceLog?.path) paths.push(workspaceLog.path);
  return Array.from(new Set(paths));
}

function buildProactiveNextMission(name, owner, context, approvalPacket) {
  const hasMember = context?.member_context?.member_exists;
  const proposedMember = context?.proposed_member || owner;
  return {
    status: 'suggested_after_operator_approval',
    objective: hasMember
      ? `Run ${name} with ${owner} until the first proof receipt is ready.`
      : `Select or create ${proposedMember}, then run ${name} until the first proof receipt is ready.`,
    why_now: 'This is the most direct next mission from the messy input, selected member, logs, and thinking.md.',
    selected_member: owner,
    context_paths: contextPaths(context),
    approval_question: `Start this as the next mission after you approve ${name}?`,
    start_command: approvalPacket.approved_next_command,
    member_setup_command: hasMember ? null : `atris member create ${proposedMember}`,
    stop_rule: 'Stop at one proof receipt, one approval question, or one real blocker.',
  };
}

function memberRouteReason(context) {
  const reason = context?.selection_reason || '';
  if (reason.includes('explicit')) return 'you named this owner';
  if (reason.includes('task_signal')) return 'the task language points at this owner';
  if (reason.includes('exact')) return 'the task names this owner directly';
  if (context?.member_context?.member_exists) return 'this is the best available owner for the task';
  if (context?.available_members?.length) return 'no perfect owner matched, so this is a routing suggestion';
  return 'no members exist yet, so Atris should reason from the task first';
}

function buildMemberRoute(name, owner, context, approvalPacket) {
  const hasMember = context?.member_context?.member_exists;
  const proposedMember = context?.proposed_member || owner;
  const suggestedMember = hasMember ? owner : proposedMember;
  const alternatives = (context?.available_members || [])
    .filter((member) => member !== owner)
    .slice(0, 5);
  return {
    status: hasMember ? 'suggested_member' : 'needs_member_selection',
    suggested_member: suggestedMember,
    editable: true,
    why: memberRouteReason(context),
    approval_prompt: `I think ${suggestedMember} should own ${name}. Approve or change the member?`,
    change_hint: 'Change the route before approval with --owner <member>.',
    alternatives,
    approve_command: approvalPacket.approved_next_command,
    setup_command: hasMember ? null : `atris member create ${suggestedMember}`,
  };
}

function buildTaskPlanPreview(name, summary, owner, context, goalChain, firstProofStep, memberRoute) {
  return {
    schema: 'atris.mission_room_task_plan_preview.v1',
    order: 'task_first',
    task: summary,
    mission: name,
    first_goal: goalChain.first_goal,
    first_proof_step: firstProofStep,
    stop_rule: 'Stop at one proof receipt, one approval question, or one real blocker.',
    member_route: memberRoute,
    context_paths: contextPaths(context),
    preview_then_route: `First understand the task. Then suggest ${owner} as editable routing.`,
  };
}

function buildTimelinePreview(name, summary, owner, goalChain) {
  return {
    schema: 'atris.mission_room_timeline_preview.v1',
    mode: 'human_goal_chain',
    items: [
      {
        order: 1,
        title: 'Messy ask captured',
        did: `Turned "${summary}" into ${name}.`,
        meant: 'The room starts from the operator truth, not a generic task template.',
      },
      {
        order: 2,
        title: 'Goal set',
        did: goalChain.first_goal,
        meant: 'Atris runs one bounded goal before proposing another.',
      },
      {
        order: 3,
        title: 'Goal done',
        did: 'Build the smallest artifact or change, then attach a receipt.',
        meant: 'The operator reviews visible proof instead of internal run noise.',
      },
      {
        order: 4,
        title: 'Next goal set',
        did: `Route the next proof step to ${owner} only after approval or proof.`,
        meant: 'The loop can continue without hiding priority or taste decisions.',
      },
      {
        order: 5,
        title: 'Mission accomplished',
        did: 'Stop when the proof is strong enough to accept, revise, or ship.',
        meant: 'The final handoff is a short story plus links to inspectable proof.',
      },
    ],
  };
}

function buildPendingResultLanding(name, owner, timelinePreview) {
  return {
    schema: 'atris.mission_room_result.v1',
    status: 'pending_goal_run',
    landing: {
      status: 'pending_goal_run',
      changed: `Room open: ${name} is being clarified before ${owner} runs a goal.`,
      checked: 'Plan preview, member route, timeline, and approval gate are prepared; no mission goal has run yet.',
      proof: null,
      decision: 'Approve to start one bounded goal, revise the room, or stop before execution.',
      timeline_preview: timelinePreview?.items || [],
    },
  };
}

function buildChatZone(name, owner, taskPlanPreview, timelinePreview, approvalPacket) {
  return {
    schema: 'atris.mission_room_chat_zone.v1',
    status: 'clarifying',
    current_step: 'shape_the_mission_before_execution',
    member: owner,
    plan_preview: {
      mission: name,
      first_goal: taskPlanPreview?.first_goal || `Prove ${name} with the smallest inspectable receipt.`,
      first_proof_step: taskPlanPreview?.first_proof_step,
      stop_rule: taskPlanPreview?.stop_rule,
    },
    timeline_preview: timelinePreview?.items || [],
    approval_gate: {
      status: approvalPacket?.status || 'awaiting_operator_approval',
      decision_options: approvalPacket?.decision_options || ['approve', 'revise', 'stop'],
      approve_question: approvalPacket?.approve_question || `Approve ${name} as the mission?`,
    },
    execution_policy: 'Do not start a mission goal until the operator approves this room.',
    result_landing_policy: 'Use result.landing only after a bounded goal runs and proof exists.',
  };
}

function buildMissionRoom(input, options = {}) {
  const normalized = normalizeInput(input);
  if (!normalized) {
    const err = new Error('Mission Room needs messy input.');
    err.code = 'MISSION_ROOM_INPUT_REQUIRED';
    throw err;
  }

  const name = missionName(normalized);
  const owner = options.owner || 'mission-lead';
  const summary = sentenceExcerpt(normalized);
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  const slug = slugify(name);
  const clarifyingQuestions = buildClarifyingQuestions();
  const approvalPacket = buildApprovalPacket(name, summary, owner);
  const goalChain = buildGoalChain(name);
  const timelinePreview = buildTimelinePreview(name, summary, owner, goalChain);
  const firstProofStep = 'Create the smallest artifact or change that proves this mission advanced, then attach a verifier, receipt path, screenshot, or human accept gate.';
  const context = collectMissionRoomContext(normalized, {
    root: options.root || process.cwd(),
    owner,
    ownerResolution: options.ownerResolution,
  });
  const memberRoute = buildMemberRoute(name, owner, context, approvalPacket);
  const taskPlanPreview = buildTaskPlanPreview(name, summary, owner, context, goalChain, firstProofStep, memberRoute);
  const proactiveNextMission = buildProactiveNextMission(name, owner, context, approvalPacket);
  const result = buildPendingResultLanding(name, owner, timelinePreview);
  const chatZone = buildChatZone(name, owner, taskPlanPreview, timelinePreview, approvalPacket);

  return {
    schema: 'atris.mission_room.v1',
    name,
    owner,
    source: {
      input_hash: hash,
      excerpt: summary,
    },
    truth_snapshot: summary,
    target_outcome: `Move from messy intent to a proof-backed mission: ${summary}`,
    stop_doing: [
      'Do not widen scope before the first proof step.',
      'Do not turn this into generic AI agent positioning.',
      'Do not leave the room without a receipt someone can inspect.',
    ],
    member_context: context.member_context,
    memory_context: context.memory_context,
    context,
    chat_zone: chatZone,
    task_plan_preview: taskPlanPreview,
    member_route: memberRoute,
    clarifying_questions: clarifyingQuestions,
    approval_packet: approvalPacket,
    goal_chain: goalChain,
    timeline_preview: timelinePreview,
    proactive_next_mission: proactiveNextMission,
    result,
    first_proof_step: firstProofStep,
    verifier: 'Receipt must include mission name, truth snapshot, target outcome, stop-doing list, first proof step, and share line.',
    share_line: `This mission moved from chaos to proof: ${name}. Inspect the receipt or claim the next step.`,
    next_command: `After approval: ${approvalPacket.approved_next_command}`,
    receipt_slug: slug,
  };
}

function missionRoomReceiptPath(room, root = process.cwd(), now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join('atris', 'runs', `mission-room-${stamp}-${room.receipt_slug}.json`);
}

function writeMissionRoomReceipt(room, options = {}) {
  const root = options.root || process.cwd();
  const at = options.at || new Date();
  const thinkingMemory = writeThinkingMemory(room, { root, at });
  const thinkingAbsolutePath = path.join(root, thinkingMemory.path);
  const thinkingContext = {
    ...(room.memory_context?.thinking || {}),
    path: thinkingMemory.path,
    exists: true,
    purpose: 'operator judgment, approval rules, proof standards, and recurring mission signals.',
    excerpt: readFileExcerpt(thinkingAbsolutePath),
  };
  const memoryContext = {
    ...(room.memory_context || {}),
    thinking: thinkingContext,
  };
  const context = room.context ? {
    ...room.context,
    memory_context: {
      ...(room.context.memory_context || {}),
      thinking: thinkingContext,
    },
  } : null;
  const roomWithMemory = {
    ...room,
    memory_context: memoryContext,
    ...(context ? { context } : {}),
    thinking_memory: thinkingMemory,
  };
  const relativePath = missionRoomReceiptPath(roomWithMemory, root, at);
  const absolutePath = path.join(root, relativePath);
  const receipt = {
    schema: 'atris.mission_room_receipt.v1',
    at: at.toISOString(),
    product_wedge: 'Chaos -> Mission Room',
    room: roomWithMemory,
    thinking_memory: thinkingMemory,
    receipt_path: relativePath,
  };

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  return { receipt, relativePath, absolutePath, room: roomWithMemory };
}

function missionRoomLines(room, receiptPath) {
  const timelineItems = (room.timeline_preview?.items || [])
    .map((item) => `    ${item.order}. ${item.title}: ${item.did} Meaning: ${item.meant}`);
  return [
    'Mission Room',
    `  Chat zone: ${room.chat_zone?.status || 'clarifying'} (no goal runs until approve)`,
    `  Task plan preview: ${room.task_plan_preview?.task || room.truth_snapshot}`,
    `  Mission: ${room.name}`,
    `  Member route: ${room.member_route?.suggested_member || room.owner} (editable; ${room.member_route?.why || room.member_context?.status || 'suggested'})`,
    `  First proof: ${room.task_plan_preview?.first_proof_step || room.first_proof_step}`,
    `  Stop rule: ${room.task_plan_preview?.stop_rule || 'Stop at one proof receipt, one approval question, or one real blocker.'}`,
    `  Context: ${(room.task_plan_preview?.context_paths || room.proactive_next_mission?.context_paths || []).join(' | ') || 'task first'}`,
    `  Clarify: ${room.clarifying_questions.map((question) => question.question).join(' | ')}`,
    `  Approval: ${room.approval_packet.approve_question} (${room.approval_packet.decision_options.join('/')}; member can change)`,
    `  Goal chain: ${room.goal_chain.loop}`,
    '  Timeline preview:',
    ...(timelineItems.length ? timelineItems : ['    1. Goal set: pending. Meaning: prove one visible step before the next goal.']),
    `  Thinking: ${room.thinking_memory?.path || 'atris/thinking.md'}`,
    `  Proactive suggestion: ${room.proactive_next_mission?.objective || room.goal_chain.first_goal}`,
    `  Result landing: ${room.result?.landing?.status || 'pending_goal_run'} -> stays pending until a goal runs and proof exists`,
    `  Verifier: ${room.verifier}`,
    `  Share: ${room.share_line}`,
    `  Receipt: ${receiptPath}`,
    `  After approve: ${room.approval_packet.approved_next_command}`,
  ];
}

module.exports = {
  buildMissionRoom,
  writeMissionRoomReceipt,
  missionRoomLines,
  writeThinkingMemory,
  collectMissionRoomContext,
};
