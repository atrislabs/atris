'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskReviewVerificationFocus } = require('../commands/task/review-evidence/review-evidence');

const longFiles = Array.from({ length: 10 }, (_, index) => `test/long-${index}.test.js`).join(' ');
const longCommand = `node --check ${longFiles}`;
assert.ok(longCommand.length > 180);

const cases = [
  [
    'comma proof commands',
    'Installed Atris review-chat command extraction changed. Verification passed: node --check commands/task.js, verified node --check test/commands.test.js 295/295, scoped git status --porcelain -- commands/task.js test/commands.test.js clean, live ATRIS_SKIP_UPDATE_CHECK=1 atris task status --json returned ok',
    [
      'node --check commands/task.js',
      'node --check test/commands.test.js',
      'git status --porcelain -- commands/task.js test/commands.test.js',
      'ATRIS_SKIP_UPDATE_CHECK=1 atris task status --json',
    ],
  ],
  [
    'narrated cli proof commands',
    'Validation passed: node /Users/owner/arena/atris-cli/bin/atris.js business check printed Ready: yes; node /Users/owner/arena/atris-cli/bin/atris.js business share --write wrote atris/reports/share.md; node /Users/owner/arena/atris-cli/bin/atris.js app list reported agentgrads-match-room runtime=local',
    [
      'node /Users/owner/arena/atris-cli/bin/atris.js business check',
      'node /Users/owner/arena/atris-cli/bin/atris.js business share --write',
      'node /Users/owner/arena/atris-cli/bin/atris.js app list',
    ],
  ],
  [
    'path then passed proof commands',
    'Inspected commands/workflow.js, bin/atris.js, and atris/MAP.md. Passed: node --check commands/workflow.js; node --check test/apps.test.js (11/11); git status --porcelain -- commands/workflow.js bin/atris.js atris/MAP.md clean',
    [
      'node --check commands/workflow.js',
      'node --check test/apps.test.js',
      'git status --porcelain -- commands/workflow.js bin/atris.js atris/MAP.md',
    ],
  ],
  [
    'chained proof commands',
    'Verified node --check commands/task.js && node --check lib/task-db.js; node --check test/auto-accept-certified.test.js 6/6; typecheck passed; installed Atris review-chat command extraction changed; installed atris temp review-chat smoke confirmed specificity; installed atris smoke confirmed review-chat specificity',
    [
      'node --check commands/task.js',
      'node --check lib/task-db.js',
      'node --check test/auto-accept-certified.test.js',
    ],
  ],
  [
    'fenced proof commands',
    '```bash\nnode --check commands/task.js\nnode --check test/json-output.test.js passed\n```',
    [
      'node --check commands/task.js',
      'node --check test/json-output.test.js',
    ],
  ],
  [
    'trim status details',
    'Full `node --check test/commands.test.js` passed: 299 tests, 0 failures.',
    [
      'node --check test/commands.test.js',
    ],
  ],
  [
    'trim status punctuation',
    'node --check test/commands.test.js passed.',
    [
      'node --check test/commands.test.js',
    ],
  ],
  [
    'reject prose pseudo command',
    'validation passed: node command tests passed; run_id=123456789',
    [],
  ],
  [
    'reject npm prose pseudo command',
    'validation passed: npm command tests passed; run_id=123456789',
    [],
  ],
  [
    'reject plural prose pseudo commands',
    'validation passed: typechecks passed, git checks passed; run_id=123456789',
    [],
  ],
  [
    'semicolon prose segment',
    'Receipt saved at atris/runs/proof.json. node --check commands/task.js; focused three-test command; git status --porcelain -- commands/task.js test/commands.test.js',
    [
      'node --check commands/task.js',
      'git status --porcelain -- commands/task.js test/commands.test.js',
    ],
  ],
  [
    'then joined commands',
    'node --check commands/task.js then node --check test/commands.test.js passed',
    [
      'node --check commands/task.js',
      'node --check test/commands.test.js',
    ],
  ],
  [
    'preserve pipeline command',
    'curl -fsS http://127.0.0.1:8000/api/health | rg ok passed',
    [
      'curl -fsS http://127.0.0.1:8000/api/health | rg ok',
    ],
  ],
  [
    'trim parenthesized status',
    'node --check test/commands.test.js (passed)',
    [
      'node --check test/commands.test.js',
    ],
  ],
  [
    'trim exit status annotation',
    'node --check test/commands.test.js passed (exit 0)',
    [
      'node --check test/commands.test.js',
    ],
  ],
  [
    'trim status sentence',
    'validation passed: node --check commands/task.js passed. Output clean.',
    [
      'node --check commands/task.js',
    ],
  ],
  [
    'trim pass count suffix',
    'full node --check test/commands.test.js passed 299/299',
    [
      'node --check test/commands.test.js',
    ],
  ],
  [
    'trim pass count explanation',
    "node --check test/mission-status.test.js passed 51/51, including the new regression 'mission tick keeps task-backed always-on caller-session missions runnable without verifier'. Live proof: atris mission tick mission-abc.",
    [
      'node --check test/mission-status.test.js',
    ],
  ],
  [
    'trim changed files tail',
    'node --check test/mission-status.test.js passed 46/46. Changed files: lib/mission-room.js adds business-move naming.',
    [
      'node --check test/mission-status.test.js',
    ],
  ],
  [
    'trim passed with tail',
    'node scripts/verify-mission-room.js passed with member=mission-lead. node --check test/mission-status.test.js passed.',
    [
      'node scripts/verify-mission-room.js',
      'node --check test/mission-status.test.js',
    ],
  ],
  [
    'ignore example command subject',
    'Product proof: review packets no longer ask humans to rerun result text like node scripts/verify-mission-room.js passed with member=mission-lead. Checks: node -c commands/task.js; git status --porcelain.',
    [
      'node -c commands/task.js',
      'git status --porcelain',
    ],
  ],
  [
    'trim comma result prose',
    'Receipt saved at atris/runs/proof.json. node --check commands/mission.js passed, live run proved stderr_empty=true. Checks: git status --porcelain.',
    [
      'node --check commands/mission.js',
      'git status --porcelain',
    ],
  ],
  [
    'split focused suite verifier',
    'node scripts/verify-mission-room.js. Focused suite also passed separately: node --check test/mission-status.test.js.',
    [
      'node scripts/verify-mission-room.js',
      'node --check test/mission-status.test.js',
    ],
  ],
  [
    'trim comma prose command list',
    'Verified commands/task.js with node -c commands/task.js passed, command suite, clean dry-run, brain compile.',
    [
      'node -c commands/task.js',
    ],
  ],
  [
    'ignore described command subject',
    'Receipt saved at atris/runs/proof.json. Product proof: parser extracts only node --check test/mission-status.test.js. Checks: node -c commands/task.js; git status --porcelain.',
    [
      'node -c commands/task.js',
      'git status --porcelain',
    ],
  ],
  [
    'quoted product command example',
    "Product proof: live Mission Report plain text now ends with 'Next: atris mission run mission-2026-06-30-work-overnight-and-see-where-1858e505' instead of 'Next: next move: run ...'. JSON still keeps operator_next raw for machines. Checks: node -c commands/mission.js; node --check test/mission-status.test.js --test-name-pattern 'mission report' (60 pass); git status --porcelain.",
    [
      'node -c commands/mission.js',
      "node --check test/mission-status.test.js --test-name-pattern 'mission report'",
      'git status --porcelain',
    ],
  ],
  [
    'trim human gate tail',
    'Receipt saved at atris/runs/proof.json. node --check test/commands.test.js. Reward remains 0; no human accept or XP.',
    [
      'node --check test/commands.test.js',
    ],
  ],
  [
    'reject human accept proof prose',
    'node --check commands/task.js passed. Do not run atris task accept OBL-1; no human accept or XP.',
    [
      'node --check commands/task.js',
    ],
  ],
  [
    'preserve long verifier command',
    `${longCommand} passed`,
    [
      longCommand,
    ],
  ],
  [
    'json named verifier file',
    '`node --check test/json-output.test.js` passed',
    [
      'node --check test/json-output.test.js',
    ],
  ],
];

for (const [name, proof, commands] of cases) {
  test(`review proof command parsing: ${name}`, () => {
    const focus = taskReviewVerificationFocus({ review: { proof } });
    assert.deepEqual(focus.commands_to_verify, commands);
  });
}
