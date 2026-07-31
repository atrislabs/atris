'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRoleSet,
  buildSimulationPlan,
  deriveBusinessName,
  parseRoleNames,
  parseSimulationArgs,
  renderDryRun,
  renderEndgame,
  renderMemberMarkdown,
  slugify,
} = require('../lib/business-simulate');

const IDEA = 'a t-shirt brand for sunset lovers';
const CREATED_AT = '2026-07-30T02:40:00.000Z';

test('deriveBusinessName returns at most three meaningful title-case words with a fallback', () => {
  assert.equal(deriveBusinessName(IDEA), 'T-Shirt Brand Sunset');
  assert.equal(deriveBusinessName('build a neighborhood coffee subscription service'), 'Neighborhood Coffee Subscription');
  assert.equal(deriveBusinessName('the and for'), 'Business Simulation');
  assert.equal(deriveBusinessName('!!!'), 'Business Simulation');
});

test('slugify produces stable CLI business and member slugs', () => {
  assert.equal(slugify('  Sunset Ink & Co.  '), 'sunset-ink-co');
  assert.equal(slugify('T-Shirt Brand Sunset'), 't-shirt-brand-sunset');
  assert.equal(slugify('---'), '');
});

test('parseSimulationArgs reads idea, name, roles, and dry-run without side effects', () => {
  assert.deepEqual(parseSimulationArgs([
    IDEA,
    '--name',
    'Sunset Ink',
    '--roles=designer,brand,storefront,fulfillment',
    '--dry-run',
  ]), {
    idea: IDEA,
    businessName: 'Sunset Ink',
    businessSlug: 'sunset-ink',
    roleNames: ['designer', 'brand', 'storefront', 'fulfillment'],
    dryRun: true,
  });
});

test('parseRoleNames requires four distinct role names', () => {
  assert.deepEqual(parseRoleNames(), ['maker', 'voice', 'builder', 'ops']);
  assert.throws(() => parseRoleNames('maker,voice,ops'), /exactly 4/);
  assert.throws(() => parseRoleNames('maker,voice,ops,ops'), /distinct/);
});

test('role templating creates four idea-specific Mission, Goals, Done when, and Rules bodies', () => {
  const roles = buildRoleSet(IDEA);
  assert.deepEqual(roles.map((role) => role.name), ['maker', 'voice', 'builder', 'ops']);
  assert.deepEqual(roles.map((role) => role.key), ['maker', 'voice', 'builder', 'ops']);

  for (const role of roles) {
    assert.equal(role.goals.length, 3);
    assert.match(role.mission, /t-shirt brand for sunset lovers/);
    const markdown = renderMemberMarkdown(role);
    assert.match(markdown, /^## Mission$/m);
    assert.match(markdown, /^## Goals$/m);
    assert.match(markdown, /^## Done when$/m);
    assert.match(markdown, /^## Rules$/m);
    assert.equal((markdown.match(/^- /gm) || []).length, 5);
  }
});

test('custom role names keep the deterministic four responsibility templates', () => {
  const roles = buildRoleSet(IDEA, ['designer', 'brand', 'storefront', 'fulfillment']);
  assert.deepEqual(roles.map((role) => role.name), ['designer', 'brand', 'storefront', 'fulfillment']);
  assert.equal(roles[0].role, 'Product and design');
  assert.equal(roles[3].role, 'Numbers and fulfillment');
  assert.match(roles[0].goals[2], /brand and storefront roles/);
  assert.match(roles[1].goals[1], /storefront role/);
  assert.match(roles[2].doneWhen, /customer can open the surface/);
});

test('ENDGAME generation has one numbered item per role, one integration item, and a seeded tick log', () => {
  const roles = buildRoleSet(IDEA);
  const endgame = renderEndgame({
    businessName: 'Sunset Ink',
    idea: IDEA,
    roles,
    createdAt: CREATED_AT,
  });

  assert.match(endgame, /^# Sunset Ink - Endgame$/m);
  assert.match(endgame, /One night, one goal:/);
  assert.equal((endgame.match(/^\d+\. \[ \]/gm) || []).length, 5);
  for (const role of roles) assert.match(endgame, new RegExp(`\\(${role.name}\\):`));
  assert.match(endgame, /^5\. \[ \] Integration:/m);
  assert.match(endgame, /^## Tick log$/m);
  assert.match(endgame, /2026-07-30 02:40 UTC - business created, team hired, missions written/);
});

test('simulation plan and dry-run enumerate every member, mission, endgame file, and command', () => {
  const plan = buildSimulationPlan({
    idea: IDEA,
    businessName: 'Sunset Ink',
    roleNames: ['designer', 'brand', 'storefront', 'fulfillment'],
    createdAt: CREATED_AT,
    homeDir: '/tmp/sim-home',
  });

  assert.equal(plan.businessSlug, 'sunset-ink');
  assert.equal(plan.workspacePath, '/tmp/sim-home/arena/atris-business/sunset-ink');
  assert.equal(plan.files.length, 9);
  assert.equal(plan.files.filter((file) => file.kind === 'member').length, 4);
  assert.equal(plan.files.filter((file) => file.kind === 'mission').length, 4);
  assert.equal(plan.files.filter((file) => file.kind === 'endgame').length, 1);
  assert.equal(plan.commands.length, 9);

  const output = renderDryRun(plan);
  assert.match(output, /dry run: no cloud calls made and no files written\./);
  assert.match(output, /atris business init "Sunset Ink"/);
  assert.match(output, /--- atris\/team\/designer\/MEMBER\.md ---/);
  assert.match(output, /--- atris\/team\/fulfillment\/MISSION\.md ---/);
  assert.match(output, /--- atris\/ENDGAME\.md ---/);
});
