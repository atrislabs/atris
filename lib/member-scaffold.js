const fs = require('fs');
const path = require('path');

const MEMBER_DIRS = Object.freeze(['skills', 'tools', 'context', 'logs']);

function dateStamp(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
  return true;
}

function memberMarkdown({ name, role, description }) {
  const title = role || 'member';
  const mission = description || 'Define why this member exists and how it chooses goals.';
  return `---
name: ${name}
role: ${title}
description: ${mission}
version: 1.0.0

skills: []

permissions:
  can-read: true
  can-execute: true
  can-approve: false
  can-accept-task: false
  approval-required: []

tools: []
---

# ${title}

## Mission

${mission}

## Persona

(Define how this member communicates, their tone, and decision-making style)

## Workflow

1. Understand the request.
2. Do one bounded useful step.
3. Leave proof another teammate can trust.

## Rules

1. Stay inside this member's role and proof standard.
2. Ask when vision, taste, risk, or uncertainty matters.
`;
}

function memberSoulMarkdown({ name, role, born }) {
  return `---
name: ${name}
version: 1.0.0
born: ${born}
---

# Soul

This is who ${name} is when the rules run out.

## Beliefs

- Useful work leaves evidence another teammate can trust.
- Clear limits produce better judgment than vague autonomy.
- The mission matters more than preserving a first idea.

## Values

1. Truth before confidence.
2. Useful progress before activity.
3. Continuity before cleverness.

## Lessons

- Empty until this member earns lessons through experience.

## Edges

- **Strong:** Focused judgment within the ${role} role.
- **Weak:** Must ask when work crosses its stated authority or proof standard.

## Voice

- Understand the real need, make one grounded move, and leave the trail clearer.
`;
}

function memberMissionMarkdown({ name, role, description }) {
  const purpose = description || `Handle ${role.toLowerCase()} work for the team.`;
  return `# Mission

<!-- Human-authored purpose file. Keep this durable; runtime state belongs in .atris/state/*.jsonl and now.md. -->

## North Star

${purpose}

## How To Choose Goals

- Use MEMBER.md to stay inside ${role}'s identity, authority, and tools.
- Choose one useful bounded goal toward this mission.
- Verify the work, write the receipt, and update the log.
- Ask the human when vision, taste, risk, or uncertainty matters.
`;
}

function emptyMemberGoals(name, now = new Date()) {
  return {
    schema: 'atris.member_goals.v1',
    member: name,
    updated_at: now.toISOString(),
    goals: [],
  };
}

function initialMemberLog({ name, role, description, source, now }) {
  const stamp = now.toTimeString().slice(0, 5);
  return [
    `## ${stamp} · Member initialized`,
    `- team: ${name}`,
    `- role: ${role}`,
    description ? `- mission: ${description}` : '',
    `- source: ${source}`,
    '- status: ready_for_room',
    '',
  ].filter(Boolean).join('\n');
}

function ensureMemberBundle(memberDir, {
  name = path.basename(memberDir),
  role = 'member',
  description = 'Define why this member exists and how it chooses goals.',
  source = 'cli',
  memberContent,
  now = new Date(),
} = {}) {
  fs.mkdirSync(memberDir, { recursive: true });
  for (const dirName of MEMBER_DIRS) {
    fs.mkdirSync(path.join(memberDir, dirName), { recursive: true });
  }

  const created = [];
  const ensure = (relativePath, content) => {
    const filePath = path.join(memberDir, relativePath);
    if (writeIfMissing(filePath, content)) created.push(relativePath);
    return filePath;
  };

  const memberFile = typeof memberContent === 'string'
    ? memberContent
    : memberMarkdown({ name, role, description });
  ensure('MEMBER.md', memberFile);
  ensure('SOUL.md', memberSoulMarkdown({ name, role, born: dateStamp(now) }));
  ensure('MISSION.md', memberMissionMarkdown({ name, role, description }));
  ensure('goals.json', `${JSON.stringify(emptyMemberGoals(name, now), null, 2)}\n`);
  ensure('goals.md', '# Goals\n\n<!-- Generated from goals.json. Edit with `atris member goal/tick/review` when possible. -->\n\nNo goals yet.\n');
  const logName = `logs/${dateStamp(now)}.md`;
  const logPath = ensure(logName, initialMemberLog({ name, role, description, source, now }));

  return { created, logPath };
}

function memberBundlePresent(memberDir) {
  if (!memberDir) return false;
  const files = ['MEMBER.md', 'SOUL.md', 'MISSION.md', 'goals.json', 'goals.md'];
  for (const fileName of files) {
    if (!fs.existsSync(path.join(memberDir, fileName))) return false;
  }
  for (const dirName of MEMBER_DIRS) {
    try {
      if (!fs.statSync(path.join(memberDir, dirName)).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

module.exports = {
  ensureMemberBundle,
  memberBundlePresent,
  memberMarkdown,
};
