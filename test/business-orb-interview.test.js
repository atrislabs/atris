const test = require('node:test');
const assert = require('node:assert/strict');

const { orbInterview, readOrbReply } = require('../commands/business');

const goal = {
  id: 'goal',
  line: 'What do you want to get done?',
  choices: [{ id: 'customers', label: 'Win my first customers' }, { id: 'software', label: 'Build and ship software' }],
};
const team = {
  id: 'team',
  line: 'You tutor kids in maths. I would start you with a business team.',
  choices: [{ id: 'business', label: 'Business team' }, { id: 'fund', label: 'Fund team' }],
};

function run(steps, typed, goalArg = '') {
  const calls = [];
  const lines = [];
  const prompts = [];
  const api = async (path, options) => {
    calls.push({ path, token: options.token, body: JSON.parse(JSON.stringify(options.body)) });
    const step = steps.shift();
    if (step instanceof Error) throw step;
    return step;
  };
  const ask = async (prompt) => { prompts.push(prompt); return typed.shift(); };
  return orbInterview(ask, 'tok', goalArg, { api, log: line => lines.push(line) })
    .then(plan => ({ plan, calls, lines, prompts }));
}

test('a typed line reads as a pick, a label, or the person\'s own words', () => {
  assert.deepEqual(readOrbReply(goal, ' 2 '), { picked: ['software'], text: '' });
  assert.equal(readOrbReply(goal, '3'), null);
  assert.equal(readOrbReply(goal, '0'), null);
  assert.deepEqual(readOrbReply(goal, 'win my first customers'), { picked: ['customers'], text: '' });
  assert.deepEqual(readOrbReply(goal, 'I tutor kids'), { picked: [], text: 'I tutor kids' });
  assert.equal(readOrbReply({ ...goal, custom: false }, 'I tutor kids'), null);
  assert.equal(readOrbReply(goal, '   '), null);
  assert.deepEqual(readOrbReply({ id: 'what', line: 'What are you selling?' }, '7'), { picked: [], text: '7' });
});

test('the orb asks, hears the answer, and ends with what to make', async () => {
  const { plan, calls, lines, prompts } = await run([
    { ok: true, data: { done: false, question: goal } },
    { ok: true, data: { done: false, question: team } },
    { ok: true, data: { done: true, question: null, result: { description: 'I tutor kids in maths', template: 'business' } } },
  ], ['', '9', 'I tutor kids in maths', '1']);

  assert.deepEqual(plan, { description: 'I tutor kids in maths', template: 'business' });
  assert.deepEqual(calls.map(call => call.path), ['/orb/interview/next', '/orb/interview/next', '/orb/interview/next']);
  assert.equal(calls[0].token, 'tok');
  assert.deepEqual(calls[0].body, { interview: 'business', turns: [] });
  assert.deepEqual(calls[1].body.turns, [{ id: 'goal', picked: [], text: 'I tutor kids in maths' }]);
  assert.deepEqual(calls[2].body.turns[1], { id: 'team', picked: ['business'], text: '' });
  // An empty line and a number that is not on the list are asked again.
  assert.equal(prompts.length, 4);
  assert.deepEqual(lines.slice(0, 6), ['', '● What do you want to get done?', '', '  1  Win my first customers', '  2  Build and ship software', '']);
  assert.ok(lines.includes('● You tutor kids in maths. I would start you with a business team.'));
});

test('a goal given on the command line is the first answer', async () => {
  const { plan, calls } = await run([
    { ok: true, data: { done: false, question: team } },
    { ok: true, data: { done: true, result: { description: 'Make coffee', template: 'fund' } } },
  ], ['fund team'], 'Make coffee');
  assert.deepEqual(calls[0].body.turns, [{ id: 'goal', picked: [], text: 'Make coffee' }]);
  assert.deepEqual(plan, { description: 'Make coffee', template: 'fund' });
});

test('anything the service cannot do hands back to the plain questions', async () => {
  assert.equal((await run([{ ok: false, status: 404 }], [])).plan, null);
  assert.equal((await run([new Error('offline')], [])).plan, null);
  assert.equal((await run([{ ok: true, data: { done: true, result: { description: '' } } }], [])).plan, null);
  assert.equal((await run([{ ok: true, data: { done: false, question: { id: 'x' } } }], [])).plan, null);
  // A conversation that never ends is cut off.
  const forever = Array.from({ length: 20 }, () => ({ ok: true, data: { done: false, question: { id: 'what', line: 'More?' } } }));
  const stuck = await run(forever, Array.from({ length: 20 }, () => 'more'));
  assert.equal(stuck.plan, null);
  assert.equal(stuck.calls.length, 12);
});
