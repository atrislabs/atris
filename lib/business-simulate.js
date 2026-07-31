'use strict';

const os = require('node:os');
const path = require('node:path');

const SIMULATE_USAGE = 'Usage: atris business simulate "<idea>" [--roles a,b,c,d] [--name <business name>] [--dry-run]';
const DEFAULT_ROLE_NAMES = Object.freeze(['maker', 'voice', 'builder', 'ops']);

const NAME_STOP_WORDS = new Set([
  'a', 'an', 'and', 'build', 'create', 'for', 'from', 'launch', 'make', 'my',
  'of', 'our', 'sell', 'start', 'the', 'to', 'with',
]);

const ROLE_TEMPLATES = Object.freeze([
  {
    key: 'maker',
    role: 'Product and design',
    description: 'Owns product direction, design, and concrete product artifacts',
    mission: (idea) => `Turn "${idea}" into a concrete product direction with usable design artifacts.`,
    goals: (idea, roleNames) => [
      `Define the smallest product version of "${idea}" that a customer could understand and use`,
      'Create the core product or design artifacts needed by the rest of the team',
      `Hand the ${roleNames[1]} and ${roleNames[2]} roles clear inputs, constraints, and final source files`,
    ],
    doneWhen: '`product/` holds a clear product brief, final source artifacts, and handoff notes the other roles can use.',
    rules: [
      'Make concrete artifacts, not moodboards or vague strategy.',
      'Do not claim something is ready until the source files and proof are in the workspace.',
    ],
  },
  {
    key: 'voice',
    role: 'Brand and copy',
    description: 'Owns positioning, brand voice, product copy, and launch drafts',
    mission: (idea) => `Make "${idea}" understandable in five seconds and memorable the next day.`,
    goals: (_idea, roleNames) => [
      'Write a one-page brand brief with audience, promise, voice, and a short story',
      `Write the customer-facing product and surface copy the ${roleNames[2]} role needs`,
      'Draft a small launch package without posting or contacting anyone',
    ],
    doneWhen: '`brand/` holds the brand brief, final product copy, and clearly marked launch drafts.',
    rules: [
      'Use plain, specific language and remove generic hype.',
      'Draft only. Never publish, message customers, or make external claims without approval.',
    ],
  },
  {
    key: 'builder',
    role: 'Surface and storefront',
    description: 'Owns the customer-facing surface and the path through it',
    mission: (idea) => `Build a working customer-facing surface for "${idea}" that makes the next action obvious.`,
    goals: () => [
      'Build the smallest complete surface that presents the real product and copy',
      'Connect every primary action to a safe simulated or test-mode path',
      'Verify the full path at phone and desktop sizes and record the proof',
    ],
    doneWhen: 'A customer can open the surface, understand the offer, and complete the simulated path without a broken step.',
    rules: [
      'Use only existing approved accounts and deployment rails.',
      'Keep payments, publishing, and customer contact simulated until a human approves them.',
    ],
  },
  {
    key: 'ops',
    role: 'Numbers and fulfillment',
    description: 'Owns economics, operating choices, fulfillment, and the human handoff',
    mission: (idea) => `Make the numbers and operating path for "${idea}" honest enough to act on tomorrow morning.`,
    goals: () => [
      'Build simple unit economics with sourced assumptions and the key margin or viability test',
      'Compare practical fulfillment or delivery options and recommend one with reasons',
      'Write the exact checklist of account, payment, legal, or external steps left for a human',
    ],
    doneWhen: '`ops/` holds the economics, the operating recommendation, and a human-steps checklist.',
    rules: [
      'Use sourced numbers and label every assumption.',
      'Never create accounts, spend money, enter payment details, or hide a human-only step.',
    ],
  },
]);

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return compactText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCaseWord(word) {
  return String(word || '')
    .toLowerCase()
    .split('-')
    .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : '')
    .join('-');
}

function titleCase(value) {
  return compactText(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(' ');
}

function deriveBusinessName(idea, fallback = 'Business Simulation') {
  const words = compactText(idea).match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) || [];
  const meaningful = words.filter((word) => !NAME_STOP_WORDS.has(word.toLowerCase()));
  if (meaningful.length === 0) return fallback;
  return meaningful.slice(0, 3).map(titleCaseWord).join(' ');
}

function normalizeRoleNames(value) {
  const rawNames = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const names = rawNames.map((name) => slugify(name)).filter(Boolean);

  if (names.length !== ROLE_TEMPLATES.length) {
    throw new Error(`--roles requires exactly ${ROLE_TEMPLATES.length} comma-separated role names.`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error('--roles must contain four distinct role names.');
  }
  return names;
}

function parseRoleNames(value) {
  if (value === undefined || value === null || compactText(value) === '') {
    return [...DEFAULT_ROLE_NAMES];
  }
  return normalizeRoleNames(value);
}

function buildRoleSet(idea, roleNames = DEFAULT_ROLE_NAMES) {
  const cleanIdea = compactText(idea);
  const names = normalizeRoleNames(roleNames);

  return ROLE_TEMPLATES.map((template, index) => ({
    key: template.key,
    name: names[index],
    title: titleCase(names[index]),
    role: template.role,
    description: template.description,
    mission: template.mission(cleanIdea),
    goals: template.goals(cleanIdea, names),
    doneWhen: template.doneWhen,
    rules: [...template.rules],
  }));
}

function renderMemberMarkdown(role) {
  return [
    '---',
    `name: ${role.name}`,
    `role: ${role.title}`,
    `description: ${role.description}`,
    'version: 1.0.0',
    '',
    'skills: []',
    '',
    'permissions:',
    '  can-read: true',
    '  can-execute: true',
    '  can-approve: false',
    '  can-accept-task: false',
    '  approval-required: []',
    '',
    'tools: []',
    '---',
    '',
    `# ${role.title}`,
    '',
    '## Mission',
    role.mission,
    '',
    '## Goals',
    ...role.goals.map((goal) => `- ${goal}`),
    '',
    '## Done when',
    role.doneWhen,
    '',
    '## Rules',
    ...role.rules.map((rule) => `- ${rule}`),
    '',
  ].join('\n');
}

function renderMissionMarkdown(role) {
  return [
    `# ${role.title} Mission`,
    '',
    '## North Star',
    role.mission,
    '',
    '## Loop',
    '',
    '1. Read `atris/ENDGAME.md` and the latest tick log.',
    '2. Take the smallest unfinished item owned by this role.',
    '3. Write the artifact and proof into the workspace.',
    '4. Append the result, blocker, and next handoff to the tick log.',
    '',
    '## Stop condition',
    '',
    `Stop when ${role.doneWhen.charAt(0).toLowerCase()}${role.doneWhen.slice(1)}`,
    '',
  ].join('\n');
}

function formatCreationTime(createdAt) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid simulation creation time: ${createdAt}`);
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function renderEndgame({ businessName, idea, roles, createdAt }) {
  const definition = roles.map((role, index) =>
    `${index + 1}. [ ] ${role.title} (${role.name}): ${role.doneWhen}`
  );
  definition.push(`${roles.length + 1}. [ ] Integration: all four role outputs work together as one coherent, verified customer path.`);

  return [
    `# ${businessName} - Endgame`,
    '',
    `One night, one goal: make "${compactText(idea)}" launch-ready as a coherent business simulation. Everything done except the steps only a human can do.`,
    '',
    '## Definition of done',
    ...definition,
    '',
    '## Blocked on human (by design)',
    'Real accounts, money, legal acceptance, publishing, customer contact, and irreversible external actions stay on the operator checklist.',
    '',
    '## Tick log',
    `- ${formatCreationTime(createdAt)} - business created, team hired, missions written. Ready for the first loop.`,
    '',
  ].join('\n');
}

function parseSimulationArgs(args = []) {
  const positional = [];
  let explicitName = '';
  let rolesValue;
  let dryRun = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
    } else if (arg === '--name') {
      if (!next || next.startsWith('-')) throw new Error(`Missing value for --name.\n${SIMULATE_USAGE}`);
      explicitName = next;
      index++;
    } else if (arg.startsWith('--name=')) {
      explicitName = arg.slice('--name='.length);
    } else if (arg === '--roles') {
      if (!next || next.startsWith('-')) throw new Error(`Missing value for --roles.\n${SIMULATE_USAGE}`);
      rolesValue = next;
      index++;
    } else if (arg.startsWith('--roles=')) {
      rolesValue = arg.slice('--roles='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n${SIMULATE_USAGE}`);
    } else {
      positional.push(arg);
    }
  }

  const idea = compactText(positional.join(' '));
  if (!idea) throw new Error(SIMULATE_USAGE);

  const businessName = compactText(explicitName) || deriveBusinessName(idea);
  const businessSlug = slugify(businessName);
  if (!businessSlug) throw new Error(`Business name must contain a letter or number.\n${SIMULATE_USAGE}`);

  return {
    idea,
    businessName,
    businessSlug,
    roleNames: parseRoleNames(rolesValue),
    dryRun,
  };
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function buildSimulationPlan({
  idea,
  businessName,
  businessSlug,
  roleNames = DEFAULT_ROLE_NAMES,
  createdAt,
  homeDir = os.homedir(),
  workspacePath,
}) {
  const cleanIdea = compactText(idea);
  const name = compactText(businessName) || deriveBusinessName(cleanIdea);
  const slug = slugify(businessSlug || name) || 'business-simulation';
  const roles = buildRoleSet(cleanIdea, roleNames);
  const created = createdAt || new Date().toISOString();
  const root = workspacePath || path.join(homeDir, 'arena', 'atris-business', slug);

  const files = [];
  for (const role of roles) {
    files.push({
      path: `atris/team/${role.name}/MEMBER.md`,
      content: renderMemberMarkdown(role),
      kind: 'member',
      role,
    });
    files.push({
      path: `atris/team/${role.name}/MISSION.md`,
      content: renderMissionMarkdown(role),
      kind: 'mission',
      role,
    });
  }
  files.push({
    path: 'atris/ENDGAME.md',
    content: renderEndgame({ businessName: name, idea: cleanIdea, roles, createdAt: created }),
    kind: 'endgame',
  });

  return {
    idea: cleanIdea,
    businessName: name,
    businessSlug: slug,
    workspacePath: root,
    createdAt: created,
    roles,
    files,
    commands: [
      `atris business init ${shellQuote(name)}`,
      ...roles.flatMap((role) => [
        `atris member create ${role.name} --role=${shellQuote(role.title)} --description=${shellQuote(role.description)}`,
        `atris member push ${role.name}`,
      ]),
    ],
  };
}

function renderDryRun(plan) {
  const lines = [
    'dry run: no cloud calls made and no files written.',
    '',
    `business:  ${plan.businessName} (${plan.businessSlug})`,
    `idea:      ${plan.idea}`,
    `workspace: ${plan.workspacePath}`,
    '',
    'would run:',
    ...plan.commands.map((command) => `  ${command}`),
    '',
    `roster: ${plan.roles.map((role) => `${role.name} (${role.role})`).join(', ')}`,
  ];

  for (const file of plan.files) {
    lines.push('', `--- ${file.path} ---`, file.content.trimEnd());
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  SIMULATE_USAGE,
  buildRoleSet,
  buildSimulationPlan,
  deriveBusinessName,
  parseRoleNames,
  parseSimulationArgs,
  renderDryRun,
  renderEndgame,
  renderMemberMarkdown,
  slugify,
};
