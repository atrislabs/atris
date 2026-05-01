const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENERATED_START = '<!-- ATRIS_BRAIN_COMPILE:START -->';
const GENERATED_END = '<!-- ATRIS_BRAIN_COMPILE:END -->';

function parseArgs(args) {
  const options = {
    root: process.cwd(),
    verify: false,
    json: false,
    rating: null,
    recommendation: null,
    note: '',
    member: null,
    mode: null,
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root' && args[i + 1]) {
      options.root = args[++i];
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else if (arg === '--verify') {
      options.verify = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--rating' && args[i + 1]) {
      options.rating = args[++i];
    } else if (arg.startsWith('--rating=')) {
      options.rating = arg.slice('--rating='.length);
    } else if (arg === '--recommendation' && args[i + 1]) {
      options.recommendation = args[++i];
    } else if (arg.startsWith('--recommendation=')) {
      options.recommendation = arg.slice('--recommendation='.length);
    } else if (arg === '--note' && args[i + 1]) {
      options.note = args[++i];
    } else if (arg.startsWith('--note=')) {
      options.note = arg.slice('--note='.length);
    } else if (arg === '--member' && args[i + 1]) {
      options.member = args[++i];
    } else if (arg.startsWith('--member=')) {
      options.member = arg.slice('--member='.length);
    } else if (arg === '--mode' && args[i + 1]) {
      options.mode = args[++i];
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  const subcommand = positional[0] || 'compile';
  if (!options.note && ['yes', 'no', 'edit', 'go', 'hold'].includes(subcommand) && positional.length > 1) {
    options.note = positional.slice(1).join(' ');
  }
  if (subcommand === 'approval' || subcommand === 'approve') {
    options.decision = positional[1] || null;
    if (!options.note && positional.length > 2) {
      options.note = positional.slice(2).join(' ');
    }
  }

  return {
    subcommand,
    options: {
      ...options,
      root: path.resolve(options.root),
    },
  };
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function shortHash(value) {
  return sha256Text(value).slice(0, 12);
}

function readJsonlStats(filePath) {
  const text = readText(filePath);
  const lines = text.split('\n').filter(line => line.trim());
  let valid = 0;
  let latestTs = null;

  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      valid += 1;
      const ts = row.ts || row.timestamp || row.created_at || row.updated_at || row.sent_at || row.date;
      if (ts && (!latestTs || String(ts) > String(latestTs))) latestTs = String(ts);
    } catch {
      // Keep the raw count honest but do not fail compilation on one bad line.
    }
  }

  return {
    path: filePath,
    exists: fs.existsSync(filePath),
    rows: lines.length,
    validRows: valid,
    latestTs,
  };
}

function countTodoItems(todoText) {
  const unchecked = (todoText.match(/^\s*-\s+\[[ ]\]/gm) || []).length;
  const checked = (todoText.match(/^\s*-\s+\[[xX]\]/gm) || []).length;
  const titled = (todoText.match(/^\s*-\s+\*\*[^*]+:\*\*/gm) || []).length;
  const done = (todoText.match(/~~|DONE|✅/g) || []).length;
  return {
    open: unchecked + Math.max(0, titled - done),
    checked,
    titled,
    done,
  };
}

function listMarkdown(root, relDir, limit = 12) {
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  }

  walk(dir);
  return out;
}

function firstHeading(text, fallback) {
  const match = String(text || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function collectState(root) {
  const atrisDir = path.join(root, 'atris');
  const stateDir = path.join(root, '.atris', 'state');
  const business = readJson(path.join(root, '.atris', 'business.json')) || {};
  const todoText = readText(path.join(atrisDir, 'TODO.md'));
  const mapText = readText(path.join(atrisDir, 'MAP.md'));
  const nowText = readText(path.join(atrisDir, 'now.md'));
  const wikiStatus = readText(path.join(atrisDir, 'wiki', 'STATUS.md'));
  const status = readText(path.join(atrisDir, 'STATUS.md'));

  const stateFiles = [
    'events.jsonl',
    'episodes.jsonl',
    'scorecards.jsonl',
    'agent_tasks.jsonl',
    'agent_mail.jsonl',
    'agent_inboxes.jsonl',
    'agents.jsonl',
    'approvals.jsonl',
  ].map(name => readJsonlStats(path.join(stateDir, name)));

  const totalRows = stateFiles.reduce((sum, item) => sum + item.rows, 0);
  const validRows = stateFiles.reduce((sum, item) => sum + item.validRows, 0);
  const latestStateTs = stateFiles
    .map(item => item.latestTs)
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    generatedAt: new Date().toISOString(),
    root,
    name: business.name || business.slug || firstHeading(status || mapText, path.basename(root)),
    slug: business.slug || path.basename(root),
    business,
    todo: countTodoItems(todoText),
    hasNow: nowText.length > 0,
    nowHeading: firstHeading(nowText, null),
    hasMap: mapText.length > 0,
    hasWikiStatus: wikiStatus.length > 0,
    mapLineCount: mapText ? mapText.split('\n').length : 0,
    wikiPages: listMarkdown(root, 'atris/wiki', 20),
    stateFiles,
    totalRows,
    validRows,
    latestStateTs,
  };
}

function strongestSignal(state) {
  const mail = state.stateFiles.find(item => item.path.endsWith('agent_mail.jsonl'))?.rows || 0;
  const tasks = state.stateFiles.find(item => item.path.endsWith('agent_tasks.jsonl'))?.rows || 0;
  const scorecards = state.stateFiles.find(item => item.path.endsWith('scorecards.jsonl'))?.rows || 0;
  const episodes = state.stateFiles.find(item => item.path.endsWith('episodes.jsonl'))?.rows || 0;
  if (scorecards > 0 && episodes > 0) return `${scorecards} scorecard row(s) and ${episodes} episode row(s) are available for feedback-driven learning.`;
  if (scorecards > 0) return `${scorecards} scorecard row(s) are available for outcome scoring.`;
  if (mail > 0) return `${mail} agent-mail row(s) are available; compile them into decisions, follow-ups, and CRM memory.`;
  if (tasks > 0) return `${tasks} agent-task row(s) are available; use them to choose the next action.`;
  return 'Workspace has structure, but little scored state yet; first improvement is to create scorecards and episodes.';
}

function nextMove(state) {
  if (state.totalRows > 0 && (state.stateFiles.find(item => item.path.endsWith('scorecards.jsonl'))?.rows || 0) === 0) {
    return 'Turn existing state rows into the first scorecard so the next run has a reward signal, not just memory.';
  }
  if ((state.stateFiles.find(item => item.path.endsWith('episodes.jsonl'))?.rows || 0) === 0) {
    return 'Capture one operator approval, edit, or rejection as an episode so the brain has a learning trace.';
  }
  if (state.todo.open > 0) return 'Pick the highest-leverage open TODO item and leave a scorecard when done.';
  return 'Run a business loop, verify the result, then re-run `atris brain compile`.';
}

function rewardForRating(rating) {
  const normalized = String(rating || '').toLowerCase();
  if (normalized === 'approve' || normalized === 'approved' || normalized === 'send' || normalized === 'sent') return 1;
  if (normalized === 'edit' || normalized === 'edited') return 0.5;
  if (normalized === 'reject' || normalized === 'rejected' || normalized === 'no') return -1;
  throw new Error('rating must be approve, edit, or reject');
}

function latestRecommendation(root) {
  const brainState = readJson(path.join(root, 'atris', 'brain', 'state.json'));
  if (brainState) return nextMove(brainState);
  return nextMove(collectState(root));
}

function loadBrainState(root) {
  return readJson(path.join(root, 'atris', 'brain', 'state.json')) || collectState(root);
}

function readMemberContext(root, memberSlug) {
  if (!memberSlug) return null;
  const slug = String(memberSlug).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!slug) return null;
  const memberDir = path.join(root, 'atris', 'team', slug);
  const memberText = readText(path.join(memberDir, 'MEMBER.md'));
  if (!memberText) return null;
  return {
    slug,
    name: firstHeading(memberText, slug),
    startHere: readText(path.join(memberDir, 'START_HERE.md')),
    goals: readText(path.join(memberDir, 'goals.md')),
  };
}

function listMemberSlugs(root) {
  const teamDir = path.join(root, 'atris', 'team');
  if (!fs.existsSync(teamDir)) return [];
  return fs.readdirSync(teamDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => !name.startsWith('_'))
    .filter(name => fs.existsSync(path.join(teamDir, name, 'MEMBER.md')))
    .sort();
}

function operatorStatePath(root) {
  return path.join(root, '.atris', 'state', 'operator.json');
}

function readRememberedOperator(root) {
  const state = readJson(operatorStatePath(root));
  return state?.member || null;
}

function rememberOperator(root, member) {
  if (!member?.slug) return;
  const filePath = operatorStatePath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    member: member.slug,
    name: member.name,
    remembered_at: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
}

function memberNextMove(member) {
  if (!member) return null;
  const name = member.name || member.slug;
  const context = `${member.startHere}\n${member.goals}`;
  const identity = `${member.slug}\n${member.name}`;
  if (member.slug === 'justin' || /justin/i.test(member.name || '')) {
    return `${name}: run one customer-moving GTM rep, update the relevant workspace state within 10 minutes, and leave a scorecard.`;
  }
  if (member.slug === 'keshav' || /keshav/i.test(member.name || '')) {
    return `${name}: make one high-leverage CEO move: ship product, close a strategic loop, or make a queued decision; leave proof and a scorecard.`;
  }
  if (/gtm|forward deployed/i.test(identity) || /gtm|forward deployed|customer-moving|customer move/i.test(context)) {
    return `${name}: run one customer-moving GTM rep, update the relevant workspace state within 10 minutes, and leave a scorecard.`;
  }
  if (/ceo|lab/i.test(identity) || /ceo|lab|synthesis loop|decision queue|building|closing|investor/i.test(context)) {
    return `${name}: make one high-leverage CEO move: ship product, close a strategic loop, or make a queued decision; leave proof and a scorecard.`;
  }
  return `${name}: use your START_HERE, complete the first concrete work block, and leave a scorecard.`;
}

function modeNextMove(member, mode) {
  if (!member || !mode) return null;
  const normalized = String(mode).toLowerCase().replace(/[_-]+/g, ' ').trim();
  const name = member.name || member.slug;
  if (/founder|lab|idea|strategy/.test(normalized)) {
    return {
      label: 'founder lab',
      move: `${name}: think through one crazy company idea, turn it into a customer wedge hypothesis, then route execution to Justin or Build.`,
      proof: 'one idea note, one customer target, one delegated next action, and one scorecard',
    };
  }
  if (/build|builder|product|backend|code/.test(normalized)) {
    return {
      label: 'builder',
      move: `${name}: ship one product or system improvement that makes Atris easier to sell, operate, or self-improve.`,
      proof: 'one shipped diff or artifact, verification output, and one scorecard',
    };
  }
  if (/close|closer|whale|investor|customer/.test(normalized)) {
    return {
      label: 'closer',
      move: `${name}: advance one whale, investor, or strategic customer conversation with a concrete next step.`,
      proof: 'one drafted or sent message, one relationship update, one next step, and one scorecard',
    };
  }
  if (/decision|queue|approve|approval/.test(normalized)) {
    return {
      label: 'decision queue',
      move: `${name}: clear one high-leverage yes/no decision that only you should make, then delegate the follow-through.`,
      proof: 'one decision recorded, one owner assigned, one follow-up path, and one scorecard',
    };
  }
  return null;
}

function renderActivationCard(state, options = {}) {
  const requestedMember = options.member || readRememberedOperator(state.root);
  const member = readMemberContext(state.root, requestedMember);
  const move = nextMove(state);
  if (!member && !options.member) {
    return `CONTEXT: ${state.name} Brain
OPERATOR: unknown
NEXT MOVE: Tell Atris who is operating: atris brain activate --member <name> --root ${state.root}
WHY: The brain should route work by operator, customer, and proof path before it assigns the next move.
PROOF: Activation re-runs with a known operator and produces a specific work block.
FEEDBACK: yes / edit / no`;
  }
  rememberOperator(state.root, member);
  const modeMove = modeNextMove(member, options.mode);
  const next = modeMove?.move || memberNextMove(member) || move;
  const proof = modeMove?.proof || `After the move, record feedback and recompile: atris brain yes|edit|no "note" --root ${state.root} --verify && atris brain compile --root ${state.root} --verify`;
  return `CONTEXT: ${state.name} Brain${member ? `\nOPERATOR: ${member.name}` : ''}${modeMove ? `\nMODE: ${modeMove.label}` : ''}
NEXT MOVE: ${next}
WHY: This is the next business workflow to improve from atris/now.md, the compiled brain, MAP, TODO, wiki, state rows, and reward history.
PROOF: ${proof}
FEEDBACK: yes / edit / no`;
}

function renderActivationGallery(state) {
  const slugs = listMemberSlugs(state.root);
  if (slugs.length === 0) {
    return `CONTEXT: ${state.name} Brain
TEAM: no members found
NEXT MOVE: Add a member under atris/team/<name>/MEMBER.md, then run activation again.`;
  }

  return slugs.map(slug => renderActivationCard(state, { member: slug })).join('\n\n---\n\n');
}

function recordFeedback(options) {
  const root = options.root;
  const rating = String(options.rating || '').toLowerCase();
  const reward = rewardForRating(rating);
  const recommendation = options.recommendation || latestRecommendation(root);
  if (!recommendation) throw new Error('recommendation is required');

  const beforeBrain = readText(path.join(root, 'atris', 'brain', 'state.json'));
  const beforeBrainHash = shortHash(beforeBrain);
  const ts = new Date().toISOString();
  const decisionId = `brain-${ts.replace(/[^0-9TZ]/g, '').toLowerCase()}-${shortHash(`${root}|${recommendation}|${rating}|${options.note}`)}`;
  const workspace = readJson(path.join(root, '.atris', 'business.json')) || {};

  const scorecard = {
    ts,
    schema: 'atris.brain.scorecard.v1',
    decision_id: decisionId,
    workspace: workspace.slug || path.basename(root),
    business_id: workspace.business_id || null,
    workspace_id: workspace.workspace_id || null,
    recommendation,
    human_rating: rating,
    human_note: options.note || '',
    reward,
    before_brain_hash: beforeBrainHash,
    source: 'operator_feedback',
  };

  const episode = {
    ts,
    schema: 'atris.brain.feedback_episode.v1',
    episode_id: decisionId,
    task_type: 'business_brain_feedback',
    state: {
      workspace: scorecard.workspace,
      before_brain_hash: beforeBrainHash,
      recommendation,
    },
    action: {
      recommendation,
    },
    feedback: {
      rating,
      note: options.note || '',
    },
    reward,
    training_example: {
      messages: [
        { role: 'system', content: 'Recommend the next business action from the compiled Atris brain.' },
        { role: 'assistant', content: recommendation },
        { role: 'user', content: `${rating}${options.note ? `: ${options.note}` : ''}` },
      ],
    },
  };

  const stateDir = path.join(root, '.atris', 'state');
  appendJsonl(path.join(stateDir, 'scorecards.jsonl'), scorecard);
  appendJsonl(path.join(stateDir, 'episodes.jsonl'), episode);

  return { scorecard, episode };
}

function normalizeApprovalDecision(decision) {
  const normalized = String(decision || '').toLowerCase();
  if (normalized === 'go') return 'go';
  if (normalized === 'edit') return 'edit';
  if (normalized === 'hold') return 'hold';
  throw new Error('decision must be go, edit, or hold');
}

function approvalStatus(decision) {
  if (decision === 'go') return 'approved_to_proceed';
  if (decision === 'edit') return 'needs_adjustment_before_action';
  return 'held_do_not_proceed';
}

function recordApproval(options) {
  const root = options.root;
  const decision = normalizeApprovalDecision(options.decision);
  const recommendation = options.recommendation || latestRecommendation(root);
  if (!recommendation) throw new Error('recommendation is required');

  const beforeBrain = readText(path.join(root, 'atris', 'brain', 'state.json'));
  const beforeBrainHash = shortHash(beforeBrain);
  const ts = new Date().toISOString();
  const approvalId = `approval-${ts.replace(/[^0-9TZ]/g, '').toLowerCase()}-${shortHash(`${root}|${recommendation}|${decision}|${options.note}`)}`;
  const workspace = readJson(path.join(root, '.atris', 'business.json')) || {};

  const approval = {
    ts,
    schema: 'atris.brain.approval.v1',
    approval_id: approvalId,
    workspace: workspace.slug || path.basename(root),
    business_id: workspace.business_id || null,
    workspace_id: workspace.workspace_id || null,
    recommendation,
    human_decision: decision,
    status: approvalStatus(decision),
    human_note: options.note || '',
    before_brain_hash: beforeBrainHash,
    source: 'operator_approval',
  };

  appendJsonl(path.join(root, '.atris', 'state', 'approvals.jsonl'), approval);
  return approval;
}

function verifyFeedback(root, decisionId) {
  const scorecards = readText(path.join(root, '.atris', 'state', 'scorecards.jsonl'));
  const episodes = readText(path.join(root, '.atris', 'state', 'episodes.jsonl'));
  if (!scorecards.includes(decisionId) || !episodes.includes(decisionId)) {
    throw new Error(`feedback rows missing decision_id ${decisionId}`);
  }
}

function verifyApproval(root, approvalId) {
  const approvals = readText(path.join(root, '.atris', 'state', 'approvals.jsonl'));
  if (!approvals.includes(approvalId)) {
    throw new Error(`approval row missing approval_id ${approvalId}`);
  }
}

function renderStatus(state) {
  return `# Atris Brain Status

- Generated: ${state.generatedAt}
- Workspace: ${state.name}
- Slug: ${state.slug}
- Root: ${state.root}
- Now loaded: ${state.hasNow ? `yes (${state.nowHeading || 'no heading'})` : 'no'}
- MAP loaded: ${state.hasMap ? `yes (${state.mapLineCount} lines)` : 'no'}
- Wiki status loaded: ${state.hasWikiStatus ? 'yes' : 'no'}
- TODO open estimate: ${state.todo.open}
- State rows: ${state.totalRows} raw / ${state.validRows} valid JSONL
- Latest state timestamp: ${state.latestStateTs || 'none found'}

## What Improved

This run compiled scattered workspace state into one loadable brain:

- source map: \`atris/MAP.md\`
- current state front door: \`atris/now.md\`
- task queue: \`atris/TODO.md\`
- wiki status: \`atris/wiki/STATUS.md\`
- run state: \`.atris/state/*.jsonl\`
- self-improvement ledger: \`atris/brain/self_improvement_ledger.md\`

## Strongest Signal

${strongestSignal(state)}

## Next Move

${nextMove(state)}

## Load Order For Future Agents

1. \`atris/now.md\`
2. \`atris/brain/STATUS.md\`
3. \`atris/brain/self_improvement_ledger.md\`
4. \`atris/wiki/concepts/sync-language.md\`
5. \`atris/skills/activation/SKILL.md\`
6. \`atris/MAP.md\`
7. \`atris/TODO.md\`
8. \`atris/wiki/index.md\`

First-message rule: follow the sync-language contract before writing to the operator.
Purpose: optimize for decision-speed; lead with the move, then use descriptions only when they help the operator act.
Shape: \`<operator>, today is about <move>\` -> \`I picked this because <why now>\` -> \`Ready: <draft/proof/context>\` -> \`Go deeper: <paths>\`.
Definitions: operator = current person or agent; move = one concrete high-leverage workflow; why now = business reason; ready = prepared action or proof; paths = 2-4 optional deeper views.
`;
}

function renderLedger(state) {
  const rows = state.stateFiles.map(item => {
    const rel = path.relative(state.root, item.path).replace(/\\/g, '/');
    return `| \`${rel}\` | ${item.exists ? 'yes' : 'no'} | ${item.rows} | ${item.validRows} | ${item.latestTs || ''} |`;
  }).join('\n');

  return `# Self-Improvement Ledger

Generated: ${state.generatedAt}

## Claim

Atris improves itself by improving the operating context future agents load: navigation, memory, task choice, proof, and reward signals.

This is not model-weight improvement yet. It is workspace-policy and context improvement.

## Current State Inputs

| Source | Exists | Rows | Valid JSONL | Latest timestamp |
|---|---:|---:|---:|---|
${rows}

## Run N -> Run N+1 Mechanism

1. Start from \`atris/now.md\`, then observe workspace state from \`.atris/state\`, TODO, MAP, wiki, and logs.
2. Compile it into \`atris/brain/STATUS.md\` and this ledger.
3. Point future agents at the compiled brain before they act.
4. After action, write scorecards, episodes, lessons, or state rows.
5. Re-run \`atris brain compile\`; the next agent starts with a better brain.

## Proof To Watch

- More valid state rows over time.
- More scorecards and episodes, not just prose.
- Fewer repeated stale TODOs.
- Faster correct next-action selection.
- Higher verified business-loop completion rate.

## Next Action

${nextMove(state)}
`;
}

function generatedBootBlock(state) {
  return `${GENERATED_START}
## Atris Brain Compile

This workspace has a compiled agent brain.

On session start, activate it first:
\`atris brain activate --root ${state.root} --verify\`

Load these first:
- \`atris/now.md\`
- \`atris/brain/STATUS.md\`
- \`atris/brain/self_improvement_ledger.md\`
- \`atris/wiki/concepts/sync-language.md\`
- \`atris/skills/activation/SKILL.md\`
- \`atris/MAP.md\`
- \`atris/TODO.md\`

First-message rule: follow the sync-language contract before writing to the operator.
Purpose: optimize for decision-speed; lead with the move, then use descriptions only when they help the operator act.
Shape: \`<operator>, today is about <move>\` -> \`I picked this because <why now>\` -> \`Ready: <draft/proof/context>\` -> \`Go deeper: <paths>\`.
Definitions: operator = current person or agent; move = one concrete high-leverage workflow; why now = business reason; ready = prepared action or proof; paths = 2-4 optional deeper views.

Re-run after meaningful work:
\`atris brain compile --root ${state.root}\`
${GENERATED_END}
`;
}

function upsertGeneratedBlock(filePath, title, block) {
  let current = readText(filePath);
  if (!current) current = `# ${title}\n\n`;

  const start = current.indexOf(GENERATED_START);
  const end = current.indexOf(GENERATED_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(end + GENERATED_END.length).trimStart();
    fs.writeFileSync(filePath, `${before}\n\n${block}${after ? `\n${after}` : ''}`, 'utf8');
    return;
  }

  fs.writeFileSync(filePath, `${current.trimEnd()}\n\n${block}`, 'utf8');
}

function writeBrain(state) {
  const brainDir = path.join(state.root, 'atris', 'brain');
  fs.mkdirSync(brainDir, { recursive: true });

  const statusPath = path.join(brainDir, 'STATUS.md');
  const ledgerPath = path.join(brainDir, 'self_improvement_ledger.md');
  const jsonPath = path.join(brainDir, 'state.json');

  fs.writeFileSync(statusPath, renderStatus(state), 'utf8');
  fs.writeFileSync(ledgerPath, renderLedger(state), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const bootBlock = generatedBootBlock(state);
  for (const fileName of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    upsertGeneratedBlock(path.join(state.root, fileName), fileName.replace(/\.md$/, ''), bootBlock);
  }

  const wikiStatusPath = path.join(state.root, 'atris', 'wiki', 'STATUS.md');
  if (fs.existsSync(wikiStatusPath)) {
    upsertGeneratedBlock(wikiStatusPath, 'Atris Wiki Status', `<!-- ATRIS_BRAIN_COMPILE:START -->
## Brain Compile

- Last compile: ${state.generatedAt}
- State rows: ${state.totalRows} raw / ${state.validRows} valid JSONL
- Strongest signal: ${strongestSignal(state)}
- Next move: ${nextMove(state)}
- Brain status: \`atris/brain/STATUS.md\`
- Ledger: \`atris/brain/self_improvement_ledger.md\`
<!-- ATRIS_BRAIN_COMPILE:END -->
`);
  }

  return { statusPath, ledgerPath, jsonPath };
}

function verifyBrain(root) {
  const required = [
    'atris/brain/STATUS.md',
    'atris/brain/self_improvement_ledger.md',
    'atris/brain/state.json',
    'AGENTS.md',
  ];
  const missing = required.filter(rel => !fs.existsSync(path.join(root, rel)));
  if (missing.length > 0) {
    throw new Error(`brain compile missing: ${missing.join(', ')}`);
  }
  const status = readText(path.join(root, 'atris', 'brain', 'STATUS.md'));
  const ledger = readText(path.join(root, 'atris', 'brain', 'self_improvement_ledger.md'));
  if (!status.includes('## Next Move') || !ledger.includes('## Run N -> Run N+1 Mechanism')) {
    throw new Error('brain compile artifacts are missing required sections');
  }
}

function brainCommand(args = process.argv.slice(3)) {
  const { subcommand, options } = parseArgs(args);
  if (subcommand === 'help' || subcommand === '--help') {
    console.log('Usage: atris brain compile [--root <workspace>] [--verify] [--json]');
    console.log('       atris brain activate [--member <slug>] [--root <workspace>] [--verify] [--json]');
    console.log('       atris brain gallery [--root <workspace>] [--verify] [--json]');
    console.log('       atris brain go|hold [note] [--recommendation <text>] [--root <workspace>] [--verify]');
    console.log('       atris brain approval go|edit|hold [note] [--recommendation <text>] [--root <workspace>] [--verify]');
    console.log('       atris brain feedback --rating approve|edit|reject [--recommendation <text>] [--note <text>] [--root <workspace>] [--verify]');
    console.log('       atris brain yes|edit|no [note] [--root <workspace>] [--verify]');
    return;
  }
  if (subcommand === 'yes') {
    options.rating = 'approve';
  } else if (subcommand === 'no') {
    options.rating = 'reject';
  } else if (subcommand === 'edit') {
    options.rating = 'edit';
  }

  if (subcommand === 'go' || subcommand === 'hold' || subcommand === 'approval' || subcommand === 'approve') {
    if (subcommand === 'go' || subcommand === 'hold') options.decision = subcommand;
    const approval = recordApproval(options);
    if (options.verify) verifyApproval(options.root, approval.approval_id);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, approval }, null, 2));
      return;
    }
    console.log('');
    console.log('Atris brain approval recorded.');
    console.log(`  Approval: ${approval.approval_id}`);
    console.log(`  Decision: ${approval.human_decision}`);
    console.log(`  Status: ${approval.status}`);
    console.log('  Wrote: .atris/state/approvals.jsonl');
    console.log('  Next: proceed only if decision is go; otherwise edit or hold.');
    if (options.verify) console.log('  Verify: passed');
    console.log('');
    return;
  }

  if (subcommand === 'feedback' || ['yes', 'no', 'edit'].includes(subcommand)) {
    const result = recordFeedback(options);
    if (options.verify) verifyFeedback(options.root, result.scorecard.decision_id);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    console.log('');
    console.log('Atris brain feedback recorded.');
    console.log(`  Decision: ${result.scorecard.decision_id}`);
    console.log(`  Rating: ${result.scorecard.human_rating}`);
    console.log(`  Reward: ${result.scorecard.reward}`);
    console.log('  Wrote: .atris/state/scorecards.jsonl');
    console.log('  Wrote: .atris/state/episodes.jsonl');
    console.log('  Next: atris brain compile');
    if (options.verify) console.log('  Verify: passed');
    console.log('');
    return;
  }
  if (subcommand === 'activate') {
    const state = collectState(options.root);
    writeBrain(state);
    if (options.verify) verifyBrain(options.root);
    const card = renderActivationCard(state, options);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, state, card }, null, 2));
      return;
    }
    console.log('');
    console.log(card);
    if (options.verify) console.log('VERIFY: brain artifacts present');
    console.log('');
    return;
  }
  if (subcommand === 'gallery') {
    const state = collectState(options.root);
    writeBrain(state);
    if (options.verify) verifyBrain(options.root);
    const gallery = renderActivationGallery(state);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, members: listMemberSlugs(options.root), gallery }, null, 2));
      return;
    }
    console.log('');
    console.log(gallery);
    if (options.verify) console.log('\nVERIFY: brain artifacts present');
    console.log('');
    return;
  }
  if (subcommand !== 'compile' && subcommand !== 'status') {
    console.error('Usage: atris brain compile [--root <workspace>] [--verify] [--json]');
    console.error('       atris brain activate [--member <slug>] [--root <workspace>] [--verify] [--json]');
    console.error('       atris brain gallery [--root <workspace>] [--verify] [--json]');
    console.error('       atris brain go|hold [note] [--recommendation <text>] [--root <workspace>] [--verify]');
    console.error('       atris brain approval go|edit|hold [note] [--recommendation <text>] [--root <workspace>] [--verify]');
    console.error('       atris brain feedback --rating approve|edit|reject [--recommendation <text>] [--note <text>] [--root <workspace>] [--verify]');
    console.error('       atris brain yes|edit|no [note] [--root <workspace>] [--verify]');
    process.exit(1);
  }

  const state = collectState(options.root);
  const written = writeBrain(state);
  if (options.verify) verifyBrain(options.root);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, state, written }, null, 2));
    return;
  }

  console.log('');
  console.log('Atris brain compiled.');
  console.log(`  Workspace: ${state.name}`);
  console.log(`  State rows: ${state.totalRows} raw / ${state.validRows} valid`);
  console.log(`  Status: ${path.relative(options.root, written.statusPath).replace(/\\/g, '/')}`);
  console.log(`  Ledger: ${path.relative(options.root, written.ledgerPath).replace(/\\/g, '/')}`);
  console.log(`  Next: ${nextMove(state)}`);
  if (options.verify) console.log('  Verify: passed');
  console.log('');
}

module.exports = {
  brainCommand,
  collectState,
  renderStatus,
  renderLedger,
  renderActivationCard,
  renderActivationGallery,
  recordFeedback,
  recordApproval,
  verifyBrain,
};
