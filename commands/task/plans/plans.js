'use strict';

// commands/task/plans/plans.js: A task's public plan: choosing the owner from the team, the plan
// card, plan preview and the plan trace.
// Owner: navigator. Moved out of commands/task.js on 2026-11-16 by lib/split-file.js; read
// README.md first.

// Names borrowed from commands/task.js and other feature folders, set by bindMain().
let fs, path, DEFAULT_OWNER, getTaskDb, wantsJson, printJson, failTask, textFlag, positional,
  writeDefaultProjection, requireTaskId, cleanPublicText, publicWords, memberTypeOf,
  GENERIC_MEMBER_SLUGS;
function bindMain(deps) {
  ({
    fs, path, DEFAULT_OWNER, getTaskDb, wantsJson, printJson, failTask, textFlag, positional,
    writeDefaultProjection, requireTaskId, cleanPublicText, publicWords, memberTypeOf,
    GENERIC_MEMBER_SLUGS,
  } = deps);
}

function parseMemberFrontmatter(text) {
  const source = String(text || '');
  if (!source.startsWith('---')) return {};
  const end = source.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = source.slice(3, end).split(/\r?\n/);
  const data = {};
  for (const raw of block) {
    const match = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return data;
}

function readTeamMembers(root = process.cwd()) {
  const teamDir = path.join(root, 'atris', 'team');
  if (!fs.existsSync(teamDir)) return [];
  return fs.readdirSync(teamDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const slug = entry.name;
      const memberPath = path.join(teamDir, slug, 'MEMBER.md');
      if (!fs.existsSync(memberPath)) return null;
      const text = fs.readFileSync(memberPath, 'utf8');
      const frontmatter = parseMemberFrontmatter(text);
      return {
        slug,
        role: cleanPublicText(frontmatter.role || slug.replace(/[-_]/g, ' '), 120),
        description: cleanPublicText(frontmatter.description || '', 240),
        type: memberTypeOf(frontmatter).type,
        path: memberPath,
      };
    })
    .filter(Boolean);
}

function scoreTeamMember(member, words, tag) {
  const slug = String(member.slug || '').toLowerCase();
  const role = String(member.role || '').toLowerCase();
  const description = String(member.description || '').toLowerCase();
  const haystack = `${slug} ${role} ${description}`.replace(/[-_]/g, ' ');
  let score = 0;
  const cleanTag = String(tag || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (cleanTag) {
    if (slug === cleanTag || slug.replace(/[-_]/g, ' ') === cleanTag) score += 12;
    else if (haystack.includes(cleanTag)) score += 5;
  }
  for (const word of words) {
    if (slug.includes(word)) score += 5;
    else if (role.includes(word)) score += 3;
    else if (description.includes(word)) score += 2;
  }
  if (GENERIC_MEMBER_SLUGS.has(slug)) score -= 3;
  return score;
}

function plainMemberDescription(member) {
  const description = cleanPublicText(member && member.description, 220);
  if (!description) return '';
  const lowered = `${description.charAt(0).toLowerCase()}${description.slice(1)}`;
  return /[.!?]$/.test(lowered) ? lowered : `${lowered}.`;
}

function chooseTaskOwner({ purpose, tag, requestedOwner, root = process.cwd() } = {}) {
  const members = readTeamMembers(root);
  const requested = cleanPublicText(requestedOwner, 80);
  if (requested) {
    const match = members.find(member => member.slug === requested);
    if (match) {
      const description = plainMemberDescription(match);
      return {
        owner: match.slug,
        member: match,
        source: 'requested',
        reason: `${match.slug} matches this work${description ? ` because ${description}` : '.'}`,
      };
    }
    return {
      owner: requested,
      member: null,
      source: 'requested',
      reason: `${requested} was requested, but no matching atris/team member was found.`,
    };
  }
  const words = publicWords(`${purpose || ''} ${tag || ''}`);
  let best = null;
  for (const member of members) {
    // A person can be named as an owner, but routing never hands them work as if they were an AI.
    if (member.type !== 'ai') continue;
    const score = scoreTeamMember(member, words, tag);
    if (!best || score > best.score) best = { member, score };
  }
  if (best && best.score > 0) {
    const member = best.member;
    const description = plainMemberDescription(member);
    return {
      owner: member.slug,
      member,
      source: 'team',
      score: best.score,
      reason: `${member.slug} fits this work${description ? ` because ${description}` : '.'}`,
    };
  }
  return {
    owner: DEFAULT_OWNER,
    member: null,
    source: 'fallback',
    reason: `${DEFAULT_OWNER} is handling it because no specific atris/team owner matched this work.`,
  };
}

function isGenericPlanActor(value) {
  const actor = cleanPublicText(value, 80).toLowerCase();
  if (!actor) return true;
  if (actor === String(DEFAULT_OWNER || '').toLowerCase()) return true;
  return GENERIC_MEMBER_SLUGS.has(actor) || new Set([
    'codex',
    'codex-executor',
    'claude',
    'claude-code',
    'cursor',
    'devin',
    'droid',
  ]).has(actor);
}

function taskTextMentionsActor(actor, text) {
  const actorWords = publicWords(actor);
  if (!actorWords.length) return false;
  const words = new Set(publicWords(text));
  return actorWords.some(word => words.has(word));
}

function buildPublicPlan({ purpose, owner, ownerReason, plan, expected }) {
  const cleanPurpose = cleanPublicText(purpose, 240);
  const cleanOwner = cleanPublicText(owner, 80);
  const cleanReason = cleanPublicText(ownerReason, 240);
  const cleanPlan = cleanPublicText(plan, 320) || `${cleanOwner || 'The owner'} will make the smallest needed change, then check the result.`;
  const cleanExpected = cleanPublicText(expected, 240) || 'the check passes and the result is ready to review.';
  return {
    purpose: cleanPurpose,
    owner: cleanOwner,
    owner_reason: cleanReason,
    plan: cleanPlan,
    expected_result: cleanExpected,
  };
}

function renderPublicPlan(plan) {
  const lines = [];
  if (plan.purpose) lines.push(`Purpose: ${plan.purpose}`);
  if (plan.owner) lines.push(`Owner: ${plan.owner} is handling it.`);
  if (plan.owner_reason) lines.push(`Why: ${plan.owner_reason}`);
  if (plan.plan) lines.push(`Plan: ${plan.plan}`);
  if (plan.expected_result) lines.push(`Expected result: ${plan.expected_result}`);
  return lines.join('\n');
}

function planTraceData(plan, ownerChoice) {
  return {
    schema: 'atris.task_plan_trace.v1',
    purpose: plan.purpose,
    owner: plan.owner,
    owner_reason: plan.owner_reason,
    plan: plan.plan,
    expected_result: plan.expected_result,
    owner_source: ownerChoice && ownerChoice.source || null,
    owner_score: ownerChoice && ownerChoice.score || null,
    recorded_at: new Date().toISOString(),
  };
}

function planTraceNote(plan, ownerChoice) {
  return `TASK_PLAN_TRACE ${JSON.stringify(planTraceData(plan, ownerChoice))}`;
}

function traceLineFromContent(content, prefix) {
  const lines = String(content || '').split(/\r?\n/);
  return lines.find(line => line.startsWith(prefix)) || '';
}

function latestTraceValue(task, prefix, key) {
  const messages = Array.isArray(task && task.messages) ? task.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = String(messages[i] && messages[i].content || '');
    const line = traceLineFromContent(content, prefix);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line.slice(prefix.length).trim());
      const value = parsed && parsed[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value);
    } catch (_) {
      continue;
    }
  }
  return '';
}

function taskHasTrace(task, prefix) {
  const messages = Array.isArray(task && task.messages) ? task.messages : [];
  if (messages.some(message => traceLineFromContent(message && message.content, prefix))) return true;
  const events = Array.isArray(task && task.events) ? task.events : [];
  return events.some(event => {
    const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (traceLineFromContent(payload.stage_packet, prefix)) return true;
    if (traceLineFromContent(payload.result_packet, prefix)) return true;
    if (prefix === 'TASK_RESULT_TRACE ' && payload.result_trace && typeof payload.result_trace === 'object') return true;
    if (prefix === 'TASK_PLAN_TRACE ' && payload.plan_trace && typeof payload.plan_trace === 'object') return true;
    return false;
  });
}

function taskPurpose(task) {
  const metadata = task && task.metadata || {};
  return cleanPublicText(
    metadata.task_goal
      || metadata.goal_objective
      || metadata.objective
      || metadata.stage_goal
      || latestTraceValue(task, 'TASK_PLAN_TRACE ', 'purpose')
      || task && task.title
      || '',
    240,
  );
}

function cmdPlanPreview(args) {
  const pos = positional(args);
  const purpose = cleanPublicText(textFlag(args, ['--purpose', '--goal', '--objective']) || pos.join(' '), 240);
  if (!purpose) failTask('atris task plan-preview', 'missing_purpose', 'purpose required');
  const tag = textFlag(args, ['--tag']);
  const requestedOwner = textFlag(args, ['--owner', '--as', '--member']);
  const planText = textFlag(args, ['--plan', '--action', '--first-move']);
  const expected = textFlag(args, ['--expected', '--expected-result', '--exit']);
  const recordRef = textFlag(args, ['--task', '--record']);
  const taskDb = getTaskDb();
  const db = taskDb.open();
  const ownerChoice = chooseTaskOwner({
    purpose,
    tag,
    requestedOwner,
    root: taskDb.workspaceRoot(),
  });
  const publicPlan = buildPublicPlan({
    purpose,
    owner: ownerChoice.owner,
    ownerReason: ownerChoice.reason,
    plan: planText,
    expected,
  });
  let recorded = null;
  if (recordRef) {
    const taskId = requireTaskId(taskDb, db, recordRef, 'atris task plan-preview');
    const note = taskDb.noteTask(db, {
      id: taskId,
      actor: publicPlan.owner || DEFAULT_OWNER,
      content: planTraceNote(publicPlan, ownerChoice),
    });
    if (!note.noted) failTask('atris task plan-preview', note.reason || 'note_failed', `plan-preview failed: ${note.reason || 'note_failed'}`, 1);
    const { outPath } = writeDefaultProjection(taskDb, db);
    recorded = {
      task_id: taskId,
      version: note.event.version,
      projection_path: outPath,
    };
  }
  if (wantsJson(args)) {
    printJson({
      ok: true,
      action: 'plan_preview',
      plan: publicPlan,
      owner_choice: {
        owner: ownerChoice.owner,
        source: ownerChoice.source,
        score: ownerChoice.score || null,
        member: ownerChoice.member ? {
          slug: ownerChoice.member.slug,
          role: ownerChoice.member.role,
          description: ownerChoice.member.description,
        } : null,
      },
      recorded,
      text: renderPublicPlan(publicPlan),
    });
    return;
  }
  console.log(renderPublicPlan(publicPlan));
}

function buildAutomaticPlanTrace(taskDb, task, { actor, actorExplicit = false, owner, goal, summary, firstMove, exit } = {}) {
  if (!task) return { trace: null, plan: null, ownerChoice: null, ownerForStage: owner || null };
  const metadata = task.metadata || {};
  const purpose = cleanPublicText(goal, 240) || taskPurpose(task);
  const claimedOwner = cleanPublicText(task.claimed_by, 80);
  // A delegated owner (metadata.assigned_to) is a functional decision already
  // recorded on the task. Only an explicit caller owner or an existing claim
  // outranks it; automatic team choice never does.
  const delegatedOwner = cleanPublicText(metadata.assigned_to, 80);
  const actorNamed = taskTextMentionsActor(actor, `${purpose} ${task.title || ''} ${task.tag || ''}`);
  const requestedActor = actorExplicit && (!isGenericPlanActor(actor) || actorNamed) ? actor : null;
  const requestedOwner = owner || claimedOwner || delegatedOwner || requestedActor || null;
  const ownerChoice = chooseTaskOwner({
    purpose,
    tag: task.tag,
    requestedOwner,
    root: taskDb.workspaceRoot(),
  });
  const publicPlan = buildPublicPlan({
    purpose,
    owner: ownerChoice.owner,
    ownerReason: ownerChoice.reason,
    plan: firstMove || summary || metadata.first_move || metadata.stage_summary || '',
    expected: exit || metadata.exit_condition || '',
  });
  return {
    trace: planTraceData(publicPlan, ownerChoice),
    plan: publicPlan,
    ownerChoice: {
      owner: ownerChoice.owner,
      source: ownerChoice.source,
      score: ownerChoice.score || null,
    },
    ownerForStage: publicPlan.owner || actor || DEFAULT_OWNER,
  };
}

module.exports = {
  bindMain, parseMemberFrontmatter, readTeamMembers, scoreTeamMember, plainMemberDescription,
  chooseTaskOwner, isGenericPlanActor, taskTextMentionsActor, buildPublicPlan, renderPublicPlan,
  planTraceData, planTraceNote, traceLineFromContent, latestTraceValue, taskHasTrace, taskPurpose,
  cmdPlanPreview, buildAutomaticPlanTrace,
};
