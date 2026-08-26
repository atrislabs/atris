'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPrompt } = require('../lib/codex-flight');
const { buildFleetPrompt } = require('../lib/fleet');

const ROOT = path.join(__dirname, '..');
const RULE_PIPED_GATES = 'piped-gate-commands-mask-exit-codes';
const RULE_HOOK_BYPASS = 'dispatched-engines-bypass-hooks-under-pressure';
const RULE_DURABLE_TASKS = 'endgame-tasks-must-be-durable-db-rows';
const RULE_ATOMIC_WORK = 'one-concern-per-pr';
const RULE_PRUNED_REVIEW_PROSE = 'review-prose-defers-to-machine-gates';
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs', '.sh', '.yaml', '.yml']);
const SOURCE_TARGETS = ['commands', 'lib', 'scripts', '.github', 'package.json'];
const PRUNED_REVIEW_INSTRUCTIONS = Object.freeze([
  {
    file: 'atris/team/validator/MEMBER.md',
    phrase: '│ ✓ Anti-slop check (see below)       │',
    gate: 'commands/slop.js',
  },
  {
    file: 'atris/team/validator/MEMBER.md',
    phrase: '**Anti-slop gate:** Run `atris/policies/ANTISLOP.md` checklist on all output. Block if violations.',
    gate: 'commands/slop.js',
  },
  {
    file: 'atris/skills/design/SKILL.md',
    phrase: '- zero shout-cased copy? zero em dashes in copy?',
    gate: 'commands/slop.js',
  },
  {
    file: 'atris/skills/copy-editor/SKILL.md',
    phrase: '[ ] No em dashes anywhere',
    gate: 'commands/slop.js',
  },
  {
    file: 'atris/policies/ANTISLOP.md',
    phrase: '- [ ] No em dashes (\u2014) unless direct quote or title separator',
    gate: 'commands/slop.js',
  },
]);

function fixtureRoot(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-correction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function sourceFiles(root, targets = SOURCE_TARGETS) {
  const files = [];
  const visit = (target) => {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
      return;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(target)) || path.basename(target) === 'package.json') {
      files.push(target);
    }
  };
  for (const target of targets) visit(path.join(root, target));
  return files;
}

function pipedGateFindings(root) {
  const pipedGate = /\b(?:npm(?:\s+run)?\s+test|node\s+--test)\b[^\n]*\|\s*(?:head|tail|grep)\b/;
  const comment = /^\s*(?:#|\/\*|\*|\/\/)/;
  const regexDeclaration = /=\s*\/.*\/[dgimsuvy]*;?\s*$/;
  const findings = [];
  for (const file of sourceFiles(root)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!comment.test(lines[index]) && !regexDeclaration.test(lines[index]) && pipedGate.test(lines[index])) {
        findings.push(`${path.relative(root, file)}:${index + 1} ${RULE_PIPED_GATES}`);
      }
    }
  }
  return findings;
}

function hookBypassFindings(briefs) {
  return briefs.flatMap(({ name, text }) => {
    const hasHookStop = /git hook blocks your commit[^\n]*(?:stop and report|stop[^\n]*report)/i.test(text);
    const forbidsBypass = /never (?:bypass (?:it )?with|use) --no-verify/i.test(text);
    return hasHookStop && forbidsBypass ? [] : [`${name} ${RULE_HOOK_BYPASS}`];
  });
}

function oneConcernPerPrFindings(briefs) {
  return briefs.flatMap(({ name, text }) => {
    const oneConcern = /one concern per PR/i.test(text);
    const splitLargerWork = /split anything larger into separate PRs/i.test(text);
    const durableHistory = /git history guides future agents/i.test(text);
    const cheapRecovery = /small PRs are cheap to revert and bisect/i.test(text);
    return oneConcern && splitLargerWork && durableHistory && cheapRecovery
      ? []
      : [`${name} ${RULE_ATOMIC_WORK}`];
  });
}

function currentDispatchBriefs() {
  return [
    {
      name: 'codex flight brief',
      text: buildPrompt({
        worktreePath: '/tmp/review-correction-codex',
        branch: 'test/review-correction',
        brief: 'Make the bounded change.',
        verifyCmd: 'node --test test/example.test.js',
      }),
    },
    {
      name: 'fleet brief',
      text: buildFleetPrompt({
        id: 'fixture-task',
        title: 'Make the bounded change. Check: node --test test/example.test.js',
      }, { worktreePath: '/tmp/review-correction-fleet' }),
    },
  ];
}

function durableTaskFindings(files) {
  return files.flatMap(({ name, text }) => {
    const durableSection = /durable-db workspaces/i.test(text);
    const durableCommand = /atris task add [^\n]*--tag endgame/i.test(text);
    const renderedWarning = /markdown task lines written into TODO\.md DO NOT SURVIVE/i.test(text);
    const markdownOnly = /markdown-only workspaces/i.test(text);
    return durableSection && durableCommand && renderedWarning && markdownOnly
      ? []
      : [`${name} ${RULE_DURABLE_TASKS}`];
  });
}

function prunedReviewInstructionFindings(root) {
  return PRUNED_REVIEW_INSTRUCTIONS.flatMap(({ file, phrase, gate }) => {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) return [];
    return fs.readFileSync(target, 'utf8').includes(phrase)
      ? [`${file} ${gate} ${RULE_PRUNED_REVIEW_PROSE}`]
      : [];
  });
}

test(RULE_PIPED_GATES, (t) => {
  const fixture = fixtureRoot(t, {
    'scripts/verify.js': "const verify = 'node --test test/unit.test.js | tail -n 20';\n",
  });

  assert.deepEqual(pipedGateFindings(fixture), [
    `scripts/verify.js:1 ${RULE_PIPED_GATES}`,
  ]);
  assert.deepEqual(pipedGateFindings(ROOT), [],
    'run test gates bare so their own exit codes reach the build');
});

test(RULE_HOOK_BYPASS, () => {
  const unsafeFixture = [{
    name: 'unsafe dispatch brief',
    text: 'Commit the change with git commit --no-verify.',
  }];

  assert.deepEqual(hookBypassFindings(unsafeFixture), [
    `unsafe dispatch brief ${RULE_HOOK_BYPASS}`,
  ]);
  assert.deepEqual(hookBypassFindings(currentDispatchBriefs()), [],
    'every dispatch brief must stop when a git hook blocks a commit');
});

test(RULE_DURABLE_TASKS, (t) => {
  const fixture = fixtureRoot(t, {
    'atris/skills/endgame/SKILL.md': 'Write every endgame task directly into atris/TODO.md.\n',
  });
  const currentSkill = path.join(ROOT, 'atris', 'skills', 'endgame', 'SKILL.md');

  assert.deepEqual(durableTaskFindings([{
    name: 'atris/skills/endgame/SKILL.md',
    text: fs.readFileSync(path.join(fixture, 'atris', 'skills', 'endgame', 'SKILL.md'), 'utf8'),
  }]), [
    `atris/skills/endgame/SKILL.md ${RULE_DURABLE_TASKS}`,
  ]);
  assert.deepEqual(durableTaskFindings([{
    name: 'atris/skills/endgame/SKILL.md',
    text: fs.readFileSync(currentSkill, 'utf8'),
  }]), [], 'database-backed tasks must be created through the task command');
});

test(RULE_ATOMIC_WORK, () => {
  const unsafeFixture = [{
    name: 'unsafe dispatch brief',
    text: 'Put every requested change into one large PR.',
  }];

  assert.deepEqual(oneConcernPerPrFindings(unsafeFixture), [
    `unsafe dispatch brief ${RULE_ATOMIC_WORK}`,
  ]);
  assert.deepEqual(oneConcernPerPrFindings(currentDispatchBriefs()), [],
    'every dispatch brief must order one concern per PR');
});

test(RULE_PRUNED_REVIEW_PROSE, (t) => {
  const files = {};
  for (const { file, phrase } of PRUNED_REVIEW_INSTRUCTIONS) {
    files[file] = `${files[file] || ''}${phrase}\n`;
  }
  const fixture = fixtureRoot(t, files);

  assert.equal(prunedReviewInstructionFindings(fixture).length, PRUNED_REVIEW_INSTRUCTIONS.length,
    'each exact pruned instruction must trip the regression gate when planted');
  assert.deepEqual(prunedReviewInstructionFindings(ROOT), [],
    'review instructions must defer deterministic checks to their machine gates');
});
