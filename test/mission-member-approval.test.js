'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const {
  memberApprovalAsks,
  objectiveNamesCategory,
  parseApprovalRequired,
  runBlockingAsks,
} = require('../lib/member-approval');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function memberText(permissions) {
  return `---\nname: gm\nrole: Game Manager\ntype: ai\npermissions:\n  can-read: true\n${permissions}\ntools: []\n---\n\n# GM\n`;
}

function makeWorkspace(approval) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-approval-'));
  const memberDir = path.join(dir, 'atris', 'team', 'game-manager');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), memberText(approval));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(dir, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function startMission(dir, objective) {
  const start = runCli(dir, ['mission', 'start', '--no-verify', objective, '--owner', 'game-manager', '--runner', 'manual', '--json']);
  assert.equal(start.status, 0, start.stderr || start.stdout);
  return JSON.parse(start.stdout).mission;
}

test('parseApprovalRequired reads inline, block, nested and top-level lists and tolerates junk', () => {
  assert.deepEqual(parseApprovalRequired(memberText('  approval-required: [merge, "delete", \'publish\']')), ['merge', 'delete', 'publish']);
  assert.deepEqual(parseApprovalRequired(memberText('  approval-required:\n    - merge\n    - spend  # money')), ['merge', 'spend']);
  assert.deepEqual(parseApprovalRequired(memberText('  approval-required: []')), []);
  assert.deepEqual(parseApprovalRequired(memberText('  can-approve: false')), []);
  assert.deepEqual(parseApprovalRequired('# no frontmatter'), []);
  assert.deepEqual(parseApprovalRequired(memberText('  approval-required: [merge, delete]').replace(/\n/g, '\r\n')), ['merge', 'delete']);
  assert.deepEqual(parseApprovalRequired('---\napproval-required: [send]\n---\n'), ['send']);
});

test('objectiveNamesCategory matches the head word of a category as a stem', () => {
  assert.equal(objectiveNamesCategory('delete the old logs', 'delete'), true);
  assert.equal(objectiveNamesCategory('deleting stale files', 'delete'), true);
  assert.equal(objectiveNamesCategory('Publish the post', 'publish'), true);
  assert.equal(objectiveNamesCategory('clean up destructive scripts', 'destructive-file-action'), true);
  assert.equal(objectiveNamesCategory('fix the bug', 'delete'), false);
  assert.equal(objectiveNamesCategory('anything', ''), false);
});

// Seen live 2026-10-13: "report the baseline read-only; do not edit files"
// seeded an approval ask for edit-production-texting-router and the run never
// started. A forbidden action is not a request for it.
test('objectiveNamesCategory ignores a category the objective forbids', () => {
  const category = 'edit-production-texting-router-without-texting-review';
  assert.equal(objectiveNamesCategory('report the baseline read-only; do not edit files', category), false);
  assert.equal(objectiveNamesCategory("don't edit anything, just read", category), false);
  assert.equal(objectiveNamesCategory('summarize the logs without deleting them', 'delete'), false);
  assert.equal(objectiveNamesCategory('never publish drafts', 'publish'), false);
  assert.equal(objectiveNamesCategory('do not edit the docs, but edit the router', category), true);
  assert.equal(objectiveNamesCategory('edit the router copy', category), true);
});

test('a plain-word synonym under a negation seeds no question, elsewhere it does', () => {
  assert.equal(objectiveNamesCategory('report only; do not delete the old logs', 'destructive-file-action'), false);
  assert.equal(objectiveNamesCategory('never email the client without asking', 'external-send'), false);
  assert.equal(objectiveNamesCategory('do not remove the cache, but wipe the temp folder', 'destructive-file-action'), true);
  assert.equal(objectiveNamesCategory('without a refund, charge the card', 'billing-change'), true);
});

// Seen live 2026-11-17: walsh (approval-required: [send, spend, ...]) was held
// on "send" by mission text that only forbade sending ("Send no email.") or
// only described owners "who answer their own email". The guard must read the
// ask, not the word.
const WALSH = ['send', 'spend', 'delete', 'deploy', 'hire', 'fire'];
const WALSH_TEXT_ONE = 'THE STORY: Atris Labs reaches $10,000 by Dec 15 with five setups at $2,000 each, sold to small business owners who answer their own email. CHAPTER ONE ends Sunday Nov 22 when: 50 hand-researched notes are out, every follow-up is current, and 3 conversations are booked. Today is Nov 17. Known facts: 6 notes sent Nov 16 with no replies yet; 3 follow-ups are past due; the mail policy record was added today but the mail signing key is still missing, so new cold notes should wait on it. RULES: drafts only. Contact no one outside the team. Send no email. Spend nothing. Promise nothing to a customer. Read-only on any money system. In any team channel post counts only, never a person, company or city name. Never write AI, agent or automate in anything a customer would read. YOUR TURN as walsh: check each teammate has one clear move for chapter one and name any move two people are both reaching for; one owner per move. Finish by posting ONE short card to the feed channel as walsh (atris channel feed "..." --as walsh) in this shape: Chapter one | my move | what I checked | what is not tracked yet | the one call for Keshav. Then stop.';
const WALSH_TEXT_TWO = 'THE STORY: Atris Labs reaches 10,000 dollars by Dec 15 with five setups at 2,000 dollars each, bought by small business owners who answer their own email. CHAPTER ONE ends Sunday Nov 22 when: 50 hand-researched notes are out, every follow-up is current, and 3 conversations are booked. Today is Nov 17. Known facts: 6 notes went out Nov 16 with no replies yet; 3 follow-ups are past due; the mail policy record was added today but the mail signing key is still missing, so new cold notes should wait on it. RULES: this is thinking and drafting work only, inside your own team folder. Nothing leaves this computer. No message goes to anyone. No money moves. No promise is made to a customer. Money systems are read-only. Never write AI, agent or automate in anything a customer would read. YOUR TURN as walsh: check each teammate has one clear move for chapter one and name any move two people are both reaching for; one owner per move. Finish by writing ONE short card to the file atris/team/walsh/cards/2026-11-17-chapter-one.md in this shape: Chapter one | my move | what I checked | what is not tracked yet | the one call for Keshav. Then stop.';

function namedBy(objective, categories) {
  return categories.filter((category) => objectiveNamesCategory(objective, category));
}

test('a plain ask to send, post or spend still seeds the question', () => {
  assert.deepEqual(namedBy('Send the weekly report to the client.', ['send']), ['send']);
  assert.deepEqual(namedBy('Email the vendor about the late order.', ['send']), ['send']);
  assert.deepEqual(namedBy('Post the card to the feed channel.', ['post']), ['post']);
  assert.deepEqual(namedBy('Spend the ad budget on the test.', ['spend']), ['spend']);
  assert.deepEqual(namedBy("Don't forget to send the invoice.", ['send']), ['send']);
  assert.deepEqual(namedBy('Do not hesitate to spend the budget.', ['spend']), ['spend']);
  assert.deepEqual(namedBy('Not only send the report, also file it.', ['send']), ['send']);
  assert.deepEqual(namedBy('Read the email, then email the client back.', ['send']), ['send']);
  assert.deepEqual(namedBy("Answer the client's email today.", ['send']), ['send']);
  assert.deepEqual(namedBy('Spend no more than $50 on ads.', ['spend']), ['spend']);
  assert.deepEqual(namedBy('Send no later than Friday.', ['send']), ['send']);
  assert.deepEqual(namedBy('The notes were sent Nov 16. Send the rest today.', ['send']), ['send']);
});

test('a pure prohibition seeds no question', () => {
  const banned = [
    ['Send no email.', 'send'],
    ['Do not send anything.', 'send'],
    ['Never post in the channel.', 'post'],
    ['Spend nothing.', 'spend'],
    ['Send nothing outside the team.', 'send'],
    ['Spend zero dollars.', 'spend'],
    ['No money moves.', 'spend'],
    ['Contact no one.', 'send'],
    ['No message goes to anyone.', 'send'],
    ['Delete nothing.', 'delete'],
  ];
  for (const [objective, category] of banned) {
    assert.equal(objectiveNamesCategory(objective, category), false, `${category} should not match "${objective}"`);
  }
});

test('a past fact about what already happened seeds no question', () => {
  assert.deepEqual(namedBy('6 notes were sent Nov 16 with no replies yet.', WALSH), []);
  assert.deepEqual(namedBy('The intro was already emailed on Monday.', WALSH), []);
  assert.deepEqual(namedBy('The old logs were deleted last week; summarize what is left.', WALSH), []);
  assert.deepEqual(namedBy('6 notes went out Nov 16; notes are out.', WALSH), []);
  assert.deepEqual(namedBy('Owners who answer their own email; check the email replies.', WALSH), []);
});

test('a sentence that both forbids and asks still seeds the question', () => {
  assert.deepEqual(namedBy('Send no email to vendors but send the invoice to the client.', ['send']), ['send']);
  assert.deepEqual(namedBy('Spend nothing except the ad budget.', ['spend']), ['spend']);
  assert.deepEqual(namedBy('Never email anyone except the client.', ['send']), ['send']);
  assert.deepEqual(namedBy('Send nothing unless the owner says yes, then send the report.', ['send']), ['send']);
  assert.deepEqual(namedBy('Do not delete the cache, delete the temp folder.', ['delete']), ['delete']);
});

// Found by an independent check of #1965: each of these asks for the act and
// slipped through on the base code too.
test('double negatives, conditions and orders about a past send still seed the question', () => {
  const asks = [
    ['Never close a ticket without emailing the customer.', 'send'],
    ['Never leave the office without sending the report.', 'send'],
    ['Do not leave without deleting the temp folder.', 'delete'],
    ['Do not finish without posting the card.', 'post'],
    ['Not a single day should pass without you emailing the owner.', 'send'],
    ['Avoid forgetting to send the invoice.', 'send'],
    ['Avoid delaying the email to the client.', 'send'],
    ['If there is no reply send a follow-up.', 'send'],
    ['If there are no objections email the client.', 'send'],
    ['Make sure the invoice has been sent to the client by Friday.', 'send'],
    ['Ensure the notes were sent before noon.', 'send'],
    ['Make sure the budget was spent by Friday.', 'spend'],
    ['Do not send email unless the owner approves.', 'send'],
  ];
  for (const [objective, category] of asks) {
    assert.equal(objectiveNamesCategory(objective, category), true, `${category} should match "${objective}"`);
  }
});

test('a ban written with a curly apostrophe or an aside is still a ban', () => {
  assert.deepEqual(namedBy('Don’t send any email today.', ['send']), []);
  assert.deepEqual(namedBy('Never, under any circumstances, send email.', ['send']), []);
  assert.deepEqual(namedBy('Do not under any circumstances send email.', ['send']), []);
  assert.deepEqual(namedBy('Summarize the logs without deleting them.', ['delete']), []);
});

test('the two real walsh mission texts seed no question', () => {
  assert.deepEqual(namedBy(WALSH_TEXT_ONE, WALSH), []);
  assert.deepEqual(namedBy(WALSH_TEXT_TWO, WALSH), []);
  // The first text does ask for a channel post, so a member gated on post is held.
  assert.deepEqual(namedBy(WALSH_TEXT_ONE, ['post']), ['post']);
});

test('plain words seed the question for policy-worded categories', () => {
  const cases = [
    ['destructive-file-action', ['delete the old logs', 'remove the temp directory', 'wipe the cache folder', 'wiping the cache folder', 'purge stale builds', 'deleting stale files', 'removal of the cache']],
    ['external-send', ['send the weekly report', 'email the client', 'publish the changelog', 'emailing every user', 'sending the invoice']],
    ['billing-change', ['charge the card on file', 'refund the customer', 'spend the ad budget']],
    ['spend', ['charge the card', 'refund the order', 'purchase more seats']],
    ['send-message-to-third-party', ['email the vendor', 'send a note to the vendor']],
  ];
  for (const [category, objectives] of cases) {
    for (const objective of objectives) {
      assert.equal(objectiveNamesCategory(objective, category), true, `${category} should match "${objective}"`);
    }
  }
});

test('the synonyms stay narrow: ordinary work does not seed a question', () => {
  const quiet = [
    'fix the typo in the readme',
    'refactor the parser and add tests',
    'rename the sender header helper',
    'make the removable media list scroll',
    'write a unit test for the loader',
    'update the docs for the new flag',
    'tidy the commit message template',
    'add a discharge summary field to the form',
  ];
  for (const category of ['destructive-file-action', 'external-send', 'billing-change', 'spend']) {
    for (const objective of quiet) {
      assert.equal(objectiveNamesCategory(objective, category), false, `${category} should not match "${objective}"`);
    }
  }
  // a category with no synonym entry still matches only its own head word
  assert.equal(objectiveNamesCategory('remove the temp files', 'merge'), false);
  assert.equal(objectiveNamesCategory('email the client', 'merge'), false);
  assert.equal(objectiveNamesCategory('send it', 'refactor-outside-scope'), false);
});

test('a member who lists external-send gets the question for "email the client"', () => {
  const dir = makeWorkspace('  approval-required: [destructive-file-action, external-send]');
  try {
    const asks = memberApprovalAsks('game-manager', dir, 'email the client and remove the old drafts');
    assert.equal(asks.length, 1);
    assert.deepEqual(asks[0].categories, ['destructive-file-action', 'external-send']);
    assert.deepEqual(memberApprovalAsks('game-manager', dir, 'fix the typo in the readme'), []);
  } finally {
    cleanup(dir);
  }
});

test('memberApprovalAsks seeds one open ask for the categories the objective names, nothing otherwise', () => {
  const dir = makeWorkspace('  approval-required: [merge, delete, publish]');
  try {
    const asks = memberApprovalAsks('game-manager', dir, 'merge the branch and delete the temp files');
    assert.equal(asks.length, 1);
    assert.deepEqual(asks[0].categories, ['merge', 'delete']);
    assert.equal(asks[0].answered_at, null);
    assert.deepEqual(memberApprovalAsks('game-manager', dir, 'fix the typo in the readme'), []);
    assert.deepEqual(memberApprovalAsks('nobody', dir, 'merge it'), []);
    assert.deepEqual(memberApprovalAsks('../etc', dir, 'merge it'), []);
  } finally {
    cleanup(dir);
  }
});

test('runBlockingAsks keeps open asks and a denied approval ask, drops answered ones', () => {
  const approval = { text: 'a', source: 'member_approval_required', answered_at: null };
  assert.equal(runBlockingAsks([approval]).length, 1);
  assert.equal(runBlockingAsks([{ ...approval, answered_at: 'x', answer: 'yes' }]).length, 0);
  assert.equal(runBlockingAsks([{ ...approval, answered_at: 'x', answer: 'no' }]).length, 1);
  assert.equal(runBlockingAsks([{ text: 'plain', answered_at: 'x', answer: 'no' }]).length, 0);
  assert.equal(runBlockingAsks(['plain string ask']).length, 1);
  assert.equal(runBlockingAsks([{ text: '  ', answered_at: null }]).length, 0);
});

test('mission start seeds a human ask from the owner MEMBER.md approval-required', () => {
  const dir = makeWorkspace('  approval-required: [merge, delete]');
  try {
    const mission = startMission(dir, 'Merge the thing and delete the scratch files');
    assert.equal(mission.human_asks.length, 1);
    assert.match(mission.human_asks[0].text, /game-manager acting on: merge, delete/);
    assert.equal(mission.human_asks[0].answered_at, null);
  } finally {
    cleanup(dir);
  }
});

test('an objective that names no approval category seeds no ask, so default members keep running', () => {
  const dir = makeWorkspace('  approval-required: [delete, refactor-outside-scope]');
  try {
    const mission = startMission(dir, 'Add a version flag to the cli');
    assert.deepEqual(mission.human_asks, []);
  } finally {
    cleanup(dir);
  }
});

test('a member with approval-required: [] seeds no ask', () => {
  const dir = makeWorkspace('  approval-required: []');
  try {
    const mission = startMission(dir, 'Ship the thing that needs nothing');
    assert.deepEqual(mission.human_asks, []);
  } finally {
    cleanup(dir);
  }
});

test('explicit mission run stops on an open human ask without ticking, and resumes after yes', () => {
  const dir = makeWorkspace('  approval-required: [merge]');
  try {
    const mission = startMission(dir, 'Merge the gated thing');
    const blocked = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
    assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.reason, 'human_asks_open');
    assert.equal(payload.ok, false);
    assert.equal(payload.next_command, 'atris decide');

    const text = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1']);
    assert.equal(text.status, 2);
    assert.match(text.stderr, /waiting on 1 human ask; not ticking/);
    assert.match(text.stderr, /atris decide/);
    const listed = JSON.parse(runCli(dir, ['mission', 'list', '--json']).stdout).missions.find((m) => m.id === mission.id);
    assert.equal(listed.status, 'planning', 'the blocked run did not tick or change the mission');

    const yes = runCli(dir, ['decide', '1', 'y', '--json']);
    assert.equal(yes.status, 0, yes.stderr || yes.stdout);
    const after = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1', '--no-claude', '--json']);
    assert.doesNotMatch(`${after.stdout}${after.stderr}`, /human_asks_open|not ticking/);
  } finally {
    cleanup(dir);
  }
});

test('answering no does not clear a seeded approval ask for an explicit run', () => {
  const dir = makeWorkspace('  approval-required: [delete]');
  try {
    const mission = startMission(dir, 'Delete the denied thing');
    const no = runCli(dir, ['decide', '1', 'n', '--json']);
    assert.equal(no.status, 0, no.stderr || no.stdout);
    const blocked = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
    assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
    assert.equal(JSON.parse(blocked.stdout).reason, 'human_asks_open');
  } finally {
    cleanup(dir);
  }
});

test('a mission with an operator --ask and no approval-required is also held by explicit run', () => {
  const dir = makeWorkspace('  approval-required: []');
  try {
    const start = runCli(dir, ['mission', 'start', '--no-verify', 'Ship asked thing', '--owner', 'game-manager', '--runner', 'manual', '--ask', 'ok to touch billing?', '--json']);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;
    const blocked = runCli(dir, ['mission', 'run', mission.id, '--max-ticks', '1', '--json']);
    assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
    assert.equal(JSON.parse(blocked.stdout).reason, 'human_asks_open');
  } finally {
    cleanup(dir);
  }
});
