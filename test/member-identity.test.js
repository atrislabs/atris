'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memberIdentityLine, missionObjectiveLine, readMemberLaunch } = require('../lib/member-identity');

test('mission prompts read back the member and objective written by the same lines', () => {
  const prompt = [
    memberIdentityLine('validator'),
    missionObjectiveLine('Check the login flow end to end'),
    '**Budget:** 3 runs',
  ].join('\n');
  assert.deepEqual(readMemberLaunch(prompt), { member: 'validator', doing: 'Check the login flow end to end' });
});

test('an objective stops at a markdown heading', () => {
  const prompt = `${memberIdentityLine('qa-bot')}\n${missionObjectiveLine('Fix flaky test')}\n# Context\nmore`;
  assert.deepEqual(readMemberLaunch(prompt), { member: 'qa-bot', doing: 'Fix flaky test' });
});

test('a mission prompt without an objective uses the whole prompt', () => {
  const prompt = memberIdentityLine('Navigator');
  assert.deepEqual(readMemberLaunch(prompt), { member: 'navigator', doing: prompt });
});

test('escaped newlines from shell logs are treated as spaces', () => {
  const prompt = `${memberIdentityLine('validator')}\\n${missionObjectiveLine('Ship it')}`;
  assert.deepEqual(readMemberLaunch(prompt), { member: 'validator', doing: 'Ship it' });
});

test('dispatch briefs name the member and the work after it', () => {
  assert.deepEqual(readMemberLaunch('You are acting as the executor. Build the page.'), {
    member: 'executor',
    doing: 'Build the page.',
  });
  assert.deepEqual(readMemberLaunch('You are acting as navigator'), {
    member: 'navigator',
    doing: 'You are acting as navigator',
  });
});

test('prompts with no member come back unchanged but whitespace-normalized', () => {
  assert.deepEqual(readMemberLaunch('  just   do\nthe thing '), { member: null, doing: 'just do the thing' });
  assert.deepEqual(readMemberLaunch(null), { member: null, doing: '' });
});

test('member names with regex characters in the objective are matched literally', () => {
  const prompt = `${memberIdentityLine('a1')} ${missionObjectiveLine('Fix (a+b)* parsing')}`;
  assert.deepEqual(readMemberLaunch(prompt), { member: 'a1', doing: 'Fix (a+b)* parsing' });
});
