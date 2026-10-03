'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SYSTEM_PROMPT,
  extractJsonObject,
  fitTeamNotes,
  linkCommand,
  linkInvocation,
  normalizeLinkAnswer,
  parseLinkArgs,
  pickLinkWorker,
  teamNote,
} = require('../commands/link');

function captureConsole(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }))
    .finally(() => { console.log = log; console.error = error; });
}

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-link-'));
  for (const name of ['bench-keeper', 'desk', 'oracle']) {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\n${name === 'oracle' ? 'status: parked\n' : ''}---\n`);
  }
  fs.writeFileSync(path.join(root, 'atris', 'team', 'bench-keeper', 'now.md'), '# Now\n\nUpdated: 2026-10-02\n\nBuilt the business-v2 task pack.\n');
  return root;
}

const REPORT = {
  jobs: [
    { job: 'search', engine: 'claude', model: 'claude-haiku-4-5-20251001' },
    { job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: null },
  ],
  team: [{ member: 'bench-keeper' }, { member: 'desk' }, { member: 'oracle' }],
};

test('link args need exactly two things and accept context, team, json', () => {
  assert.deepEqual(parseLinkArgs(['a', 'b', '--context', 'c', '--team', '--json']), {
    help: false, things: ['a', 'b'], context: 'c', team: true, json: true,
  });
  assert.equal(parseLinkArgs(['a', 'b', '--context=x']).context, 'x');
  assert.throws(() => parseLinkArgs(['only one']), /usage/);
  assert.throws(() => parseLinkArgs(['a', 'b', 'c']), /usage/);
  assert.throws(() => parseLinkArgs(['a', 'b', '--nope']), /unknown option/);
  assert.equal(parseLinkArgs(['--help']).help, true);
});

test('link rides the build lead unless the roster has a link job', () => {
  assert.deepEqual(pickLinkWorker(REPORT), { job: 'build', engine: 'claude', model: 'claude-opus-5-5', effort: '' });
  const withLink = { jobs: [...REPORT.jobs, { job: 'link', engine: 'codex', model: 'gpt-x', effort: 'low' }] };
  assert.equal(pickLinkWorker(withLink).engine, 'codex');
  assert.equal(pickLinkWorker({ jobs: [] }), null);
});

test('the system prompt is plain: no em dashes, json contract, null escape hatch', () => {
  assert.ok(!/[\u2014\u2013]/.test(SYSTEM_PROMPT));
  assert.match(SYSTEM_PROMPT, /"line": null/);
  assert.match(SYSTEM_PROMPT, /at most 12 words/);
});

test('link runs read-only from the temp folder with no tools for claude', () => {
  const invocation = linkInvocation({ engine: 'claude', model: 'claude-opus-5-5', prompt: 'hi' }, 1000);
  assert.equal(invocation.cwd, os.tmpdir());
  const tools = invocation.args.indexOf('--tools');
  assert.ok(tools >= 0);
  assert.equal(invocation.args[tools + 1], '');
  assert.ok(invocation.args.includes('plan'));
});

test('answers are shaped to the contract', () => {
  const members = ['bench-keeper', 'desk'];
  const good = normalizeLinkAnswer(extractJsonObject('```json\n{"line":"HOA rules make checkable tasks \u2014 fast","why":"a. b.","experiment":{"label":"ten tasks","scope":"does x, not y."},"by":"bench-keeper","hunch":"true"}\n```'), members);
  assert.equal(good.ok, true);
  assert.equal(good.value.line, 'HOA rules make checkable tasks, fast');
  assert.equal(good.value.by, 'bench-keeper');
  assert.equal(good.value.hunch, true);

  const stranger = normalizeLinkAnswer({ line: 'x y', why: 'a.', experiment: { label: 'l', scope: 's' }, by: 'not-a-member', hunch: false }, members);
  assert.equal(stranger.value.by, null);

  assert.deepEqual(normalizeLinkAnswer({ line: null, reason: 'nothing in common' }, members).value, { line: null, reason: 'nothing in common' });
  assert.equal(normalizeLinkAnswer({ line: 'one two three four five six seven eight nine ten eleven twelve thirteen', why: 'a', experiment: { label: 'l', scope: 's' } }, members).ok, false);
  assert.equal(normalizeLinkAnswer(extractJsonObject('no json here'), members).ok, false);
});

test('team notes skip stale and parked members and stay under the prompt limit', () => {
  const root = tempWorkspace();
  const now = Date.now();
  assert.match(teamNote(root, 'bench-keeper', now), /business-v2 task pack/);
  assert.equal(teamNote(root, 'bench-keeper', now + 6 * 86400000), null);
  assert.equal(teamNote(root, 'desk', now), null);
  const notes = Array.from({ length: 200 }, (_, index) => ({ name: `m${index}`, note: 'x'.repeat(280) }));
  const members = notes.map((entry) => entry.name);
  const prompt = fitTeamNotes({ things: ['a', 'b'], context: '' }, notes, members);
  assert.ok(Buffer.byteLength(prompt) < 16 * 1024);
  assert.match(prompt, /Other team slugs: /);
});

test('link --json prints the contract plus what ran, and only roster members can be by', async () => {
  const root = tempWorkspace();
  const prompts = [];
  const result = await captureConsole(() => linkCommand(['The HOA replies quote real rules', 'Lab pilot needs harder tasks', '--team', '--json'], {
    root,
    rosterReport: () => REPORT,
    executeAskJob: async (job) => {
      prompts.push(job);
      return {
        ok: true,
        reason: 'ok',
        duration_ms: 1234,
        stdout: JSON.stringify({ line: 'HOA rules could become harder pilot tasks', why: 'The replies quote rules. The pilot needs harder tasks.', experiment: { label: 'ten HOA tasks', scope: 'Writes ten tasks, does not touch live replies.' }, by: 'bench-keeper', hunch: true }),
        stderr: '',
      };
    },
  }));
  assert.equal(result.code, 0);
  const body = JSON.parse(result.out);
  assert.equal(body.line, 'HOA rules could become harder pilot tasks');
  assert.equal(body.by, 'bench-keeper');
  assert.equal(body.hunch, true);
  assert.deepEqual(body.ran, { job: 'build', engine: 'claude', model: 'claude-opus-5-5', seconds: 1.2, team_notes: 1 });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].engine, 'claude');
  assert.match(prompts[0].prompt, /bench-keeper: Built the business-v2 task pack/);
  assert.doesNotMatch(prompts[0].prompt, /oracle/);
});

test('link reports an engine failure as json with exit 1', async () => {
  const root = tempWorkspace();
  const result = await captureConsole(() => linkCommand(['a', 'b', '--json'], {
    root,
    rosterReport: () => REPORT,
    executeAskJob: async () => ({ ok: false, reason: 'timeout', timed_out: true, duration_ms: 180000, stdout: '', stderr: '' }),
  }));
  assert.equal(result.code, 1);
  const body = JSON.parse(result.out);
  assert.equal(body.ok, false);
  assert.match(body.error, /timed out after 180s/);
});
