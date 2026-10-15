'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  matchMember,
  matchMembers,
  stemVariants,
  tokenizeQuery,
} = require('../lib/member-match');

function makeTempDir(prefix = 'atris-member-match-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMember(root, slug, opts = {}) {
  const dir = path.join(root, 'atris', 'team', slug);
  fs.mkdirSync(dir, { recursive: true });
  const role = opts.role || 'Team Member';
  const description = opts.description || '';
  const statusLine = opts.status ? `status: ${opts.status}\n` : '';
  const typeLine = opts.type ? `type: ${opts.type}\n` : '';
  const skillsBlock = Array.isArray(opts.skills) && opts.skills.length
    ? `skills:\n${opts.skills.map((s) => `  - ${s}`).join('\n')}\n`
    : 'skills: []\n';
  const body = opts.body || `# ${slug}\n\n${opts.paragraph || ''}\n`;
  fs.writeFileSync(
    path.join(dir, 'MEMBER.md'),
    `---\nname: ${slug}\nrole: ${role}\ndescription: ${description}\n${statusLine}${typeLine}${skillsBlock}---\n\n${body}`,
    'utf8'
  );
  if (opts.mission) {
    fs.writeFileSync(path.join(dir, 'MISSION.md'), opts.mission, 'utf8');
  }
  if (opts.soul) {
    fs.writeFileSync(path.join(dir, 'SOUL.md'), opts.soul, 'utf8');
  }
}

function writeMissionJson(root, filename, payload) {
  const dir = path.join(root, '.atris', 'state', 'missions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload, null, 2), 'utf8');
}

function seedStandardTeam(root) {
  writeMember(root, 'architect', {
    role: 'Architect',
    description: 'Pre-commit skeptic before any migration, API design, or multi-file refactor.',
    paragraph: 'Judges folder boundaries, worktrees, and file structure before changes.',
  });
  writeMember(root, 'executor', {
    role: 'Builder',
    description: 'Executes concrete product and CLI changes from build specs.',
    skills: ['code-writer', 'test-runner'],
  });
  writeMember(root, 'builder', {
    role: 'Builder',
    description: 'Handles feature and command implementation.',
  });
  writeMember(root, 'interface-dev', {
    role: 'Interface Developer',
    description: 'Owns the desktop interface surfaces, editor toolbar, and user interactions.',
  });
  writeMember(root, 'auto-improver', {
    role: 'Continuous Improver',
    description: 'Fixes flaky tests, slow tests, regressions, and recurring errors every tick.',
    skills: ['repeat-error-surgeon'],
  });
  writeMember(root, 'validator', {
    role: 'Validator',
    description: 'Reviews diffs, runs slop detection, and blocks weak work before merge.',
  });
  writeMember(root, 'navigator', {
    role: 'Navigator',
    description: 'Maps the codebase and breaks ideas into clear steps.',
  });
  writeMember(root, 'youtube-lead', {
    role: 'YouTube Process Owner',
    description: 'Owns the youtube video transcript and caption notes pipeline.',
  });
}

test('matches natural-language role queries: file work, cli guy, interactions guy, slow tests, slop, youtube, desktop ui', () => {
  const root = makeTempDir();
  try {
    seedStandardTeam(root);

    const fileMatch = matchMember('file work', { root, boardRows: [] });
    assert.ok(fileMatch);
    assert.equal(fileMatch.member, 'architect');

    const cliMatch = matchMember('cli guy', { root, boardRows: [] });
    assert.ok(cliMatch);
    assert.equal(cliMatch.member, 'executor');

    const interactionsMatch = matchMember('interactions guy', { root, boardRows: [] });
    assert.ok(interactionsMatch);
    assert.equal(interactionsMatch.member, 'interface-dev');

    const slowTestsMatch = matchMember('slow tests', { root, boardRows: [] });
    assert.ok(slowTestsMatch);
    assert.equal(slowTestsMatch.member, 'auto-improver');

    const slopMatch = matchMember('slop', { root, boardRows: [] });
    assert.ok(slopMatch);
    assert.equal(slopMatch.member, 'validator');

    const youtubeMatch = matchMember('youtube', { root, boardRows: [] });
    assert.ok(youtubeMatch);
    assert.equal(youtubeMatch.member, 'youtube-lead');

    const desktopUiMatch = matchMember('desktop ui', { root, boardRows: [] });
    assert.ok(desktopUiMatch);
    assert.equal(desktopUiMatch.member, 'interface-dev');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tokenizeQuery strips filler stop-words while keeping domain words and stemVariants expands stems', () => {
  const fileTokens = tokenizeQuery('the file work guy');
  assert.deepEqual(fileTokens.map((t) => t.token), ['file']);

  const cliTokens = tokenizeQuery('please get the cli guy for this');
  assert.deepEqual(cliTokens.map((t) => t.token), ['cli']);

  const interactionVariants = stemVariants('interactions');
  assert.ok(interactionVariants.has('interaction'));
  assert.ok(interactionVariants.has('interact'));
  assert.ok(interactionVariants.has('interface'));
  assert.ok(interactionVariants.has('interactive'));

  assert.ok(stemVariants('files').has('file'));
  assert.ok(stemVariants('tests').has('test'));
  assert.ok(stemVariants('folders').has('folder'));
});

test('matches against live board job and step and .atris/state/missions/*.json with working on reason', () => {
  const root = makeTempDir();
  try {
    seedStandardTeam(root);

    writeMissionJson(root, 'mission-old.json', {
      id: 'm-old',
      owner: 'navigator',
      status: 'complete',
      objective: 'audit legacy stats.js module',
      updated_at: '2026-10-14T10:00:00Z',
    });
    writeMissionJson(root, 'mission-live.json', {
      id: 'm-live',
      owner: 'executor',
      status: 'running',
      objective: 'refactor stats.js latency counters\u2014clean output',
      updated_at: '2026-10-15T01:00:00Z',
    });

    const fromMission = matchMember('stats.js', { root, boardRows: [] });
    assert.ok(fromMission);
    assert.equal(fromMission.member, 'executor');
    assert.match(fromMission.reason, /^working on: refactor stats\.js latency counters, clean output/);
    assert.ok(!fromMission.reason.includes('\u2014'));

    const now = Date.now();
    const boardRows = [
      {
        member: 'navigator',
        state: 'working',
        alive: true,
        job: 'mappingbilling.ts routes',
        step: 'inspecting webhook handler in billing.ts',
        at: now - 60 * 1000,
      },
    ];
    const fromBoardStep = matchMember('webhook handler', { root, boardRows, now });
    assert.ok(fromBoardStep);
    assert.equal(fromBoardStep.member, 'navigator');
    assert.match(fromBoardStep.reason, /^working on: inspecting webhook handler in billing\.ts/);

    writeMissionJson(root, 'mission-architect.json', {
      id: 'm-arch',
      owner: 'architect',
      status: 'running',
      objective:
        'Continue work-folder protection across the lib/fleet.js, commands/land.js, files and worktrees',
      updated_at: '2026-10-15T02:00:00Z',
    });

    const archetypeOverIncidentalLive = matchMember('file work', { root, boardRows: [] });
    assert.ok(archetypeOverIncidentalLive);
    assert.equal(archetypeOverIncidentalLive.member, 'architect');
    assert.equal(
      archetypeOverIncidentalLive.reason,
      'judges architecture, file structure, and multi-file design before code changes'
    );

    const specificLiveQuery = matchMember('fleet.js', { root, boardRows: [] });
    assert.ok(specificLiveQuery);
    assert.equal(specificLiveQuery.member, 'architect');
    assert.match(
      specificLiveQuery.reason,
      /^working on: Continue work-folder protection across the lib\/fleet\.js, commands\/land\.js\.\.\.$/
    );
    assert.doesNotMatch(specificLiveQuery.reason, /[,:;]\.\.\.$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preferActive gives a tie-breaker boost to active members without overriding stronger text matches', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'alpha-coder', {
      role: 'Latency Specialist',
      description: 'Tunes database query caching.',
    });
    writeMember(root, 'beta-coder', {
      role: 'Latency Specialist',
      description: 'Tunes database query caching.',
    });
    writeMember(root, 'gamma-coder', {
      role: 'Security Auditor',
      description: 'Checks auth tokens and permissions.',
    });

    const now = Date.now();
    const boardRows = [
      {
        member: 'beta-coder',
        state: 'working',
        alive: true,
        job: 'general maintenance',
        step: 'running checks',
        at: now - 2 * 60 * 1000,
      },
      {
        member: 'gamma-coder',
        state: 'working',
        alive: true,
        job: 'general maintenance',
        step: 'running checks',
        at: now - 1 * 60 * 1000,
      },
    ];

    // Tie between alpha-coder and beta-coder is won by active beta-coder (+3 boost).
    const tieWinner = matchMember('database query caching', { root, boardRows, now, preferActive: true });
    assert.ok(tieWinner);
    assert.equal(tieWinner.member, 'beta-coder');

    // Without preferActive, alphabetical alpha-coder wins the tie.
    const noActiveWinner = matchMember('database query caching', { root, boardRows, now, preferActive: false });
    assert.ok(noActiveWinner);
    assert.equal(noActiveWinner.member, 'alpha-coder');

    // Active gamma-coder does not override stronger text match for database query caching.
    assert.notEqual(tieWinner.member, 'gamma-coder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('matchMembers deduplicates across 3 queries so 3 queries pick 3 distinct members', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'executor', {
      role: 'Builder',
      description: 'Builds CLI commands and terminal workflows.',
      skills: ['code-writer'],
    });
    writeMember(root, 'builder', {
      role: 'Builder',
      description: 'Implements CLI commands and features.',
    });
    writeMember(root, 'codex-executor', {
      role: 'Builder',
      description: 'Ships terminal and CLI code changes.',
    });

    const picks = matchMembers(['cli guy', 'terminal command', 'build shell feature'], {
      root,
      boardRows: [],
    });
    assert.equal(picks.length, 3);
    assert.ok(picks.every(Boolean));
    const chosenSlugs = picks.map((p) => p.member);
    assert.equal(new Set(chosenSlugs).size, 3);
    assert.deepEqual(new Set(chosenSlugs), new Set(['executor', 'builder', 'codex-executor']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns null when nothing matches (e.g. "zed") even when members are active on the board', () => {
  const root = makeTempDir();
  try {
    seedStandardTeam(root);
    writeMember(root, 'info-organizer', {
      role: 'Organizer',
      description: 'Keeps specialized and organized notes clean.',
    });

    const now = Date.now();
    const boardRows = [
      {
        member: 'executor',
        state: 'working',
        alive: true,
        job: 'shipping cli update',
        step: 'running tests',
        at: now - 10 * 1000,
      },
    ];

    assert.equal(matchMember('zed', { root, boardRows, now }), null);
    assert.equal(matchMember('   ', { root, boardRows, now }), null);
    assert.equal(matchMember('the guy who does', { root, boardRows, now }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cross-workspace matching (includeWorkspace: true) finds members in sibling repos and boardRows', () => {
  const parent = makeTempDir('atris-workspace-parent-');
  const cliRoot = path.join(parent, 'atris-cli');
  const desktopRoot = path.join(parent, 'atris-desktop');
  try {
    fs.mkdirSync(cliRoot, { recursive: true });
    fs.mkdirSync(desktopRoot, { recursive: true });

    writeMember(cliRoot, 'architect', {
      role: 'Architect',
      description: 'Judges CLI architecture and file boundaries.',
    });
    writeMember(desktopRoot, 'interface-dev', {
      role: 'Interface Developer',
      description: 'Owns the desktop UI, toolbar, and interactive views.',
    });

    // Without includeWorkspace, interface-dev is not in cliRoot.
    const localOnly = matchMember('interactions guy', { root: cliRoot, includeWorkspace: false, boardRows: [] });
    assert.equal(localOnly, null);

    // With includeWorkspace: true, sibling desktopRoot/atris/team is scanned.
    const crossRepo = matchMember('interactions guy', { root: cliRoot, includeWorkspace: true, boardRows: [] });
    assert.ok(crossRepo);
    assert.equal(crossRepo.member, 'interface-dev');
    assert.equal(crossRepo.repoRoot, desktopRoot);

    // Also matches a member present only in boardRows whose repo is elsewhere.
    const now = Date.now();
    const boardRows = [
      {
        member: 'remote-crawler',
        state: 'working',
        alive: true,
        job: 'indexing parquet datasets',
        step: 'scanning s3 buckets',
        at: now - 30 * 1000,
      },
    ];
    const fromBoardOnly = matchMember('parquet datasets', {
      root: cliRoot,
      includeWorkspace: true,
      boardRows,
      now,
    });
    assert.ok(fromBoardOnly);
    assert.equal(fromBoardOnly.member, 'remote-crawler');
    assert.match(fromBoardOnly.reason, /^working on: indexing parquet datasets/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('direct member name mention gets +60 and reason "named directly", and matching runs in under 10ms', () => {
  const root = makeTempDir();
  try {
    seedStandardTeam(root);

    const start = process.hrtime.bigint();
    const named = matchMember('ask youtube-lead to build a cli command', { root, boardRows: [] });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(named);
    assert.equal(named.member, 'youtube-lead');
    assert.equal(named.reason, 'named directly');
    assert.ok(named.score >= 60);
    assert.ok(elapsedMs < 10, `expected matchMember to run in < 10ms, took ${elapsedMs.toFixed(2)}ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stem and prefix matching connects plural/morphological queries to custom members and real repo team', () => {
  const root = makeTempDir();
  try {
    writeMember(root, 'storage-keeper', {
      role: 'Storage Keeper',
      description: 'Protects every folder and file layout on disk.',
    });
    writeMember(root, 'suite-runner', {
      role: 'Suite Runner',
      description: 'Executes each unit test before merge.',
    });
    writeMember(root, 'panel-crafter', {
      role: 'Panel Crafter',
      description: 'Polishes the user interface panels.',
    });

    assert.equal(matchMember('folders and files', { root, boardRows: [] })?.member, 'storage-keeper');
    assert.equal(matchMember('unit tests', { root, boardRows: [] })?.member, 'suite-runner');
    assert.equal(matchMember('interactions', { root, boardRows: [] })?.member, 'panel-crafter');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const repoRoot = path.resolve(__dirname, '..');
  assert.equal(matchMember('file work', { root: repoRoot, boardRows: [] })?.member, 'architect');
  assert.ok(['executor', 'builder'].includes(matchMember('cli guy', { root: repoRoot, boardRows: [] })?.member));
  assert.equal(matchMember('slow tests', { root: repoRoot, boardRows: [] })?.member, 'auto-improver');
  assert.ok(['validator', 'orb'].includes(matchMember('slop', { root: repoRoot, boardRows: [] })?.member));
  assert.equal(matchMember('youtube', { root: repoRoot, boardRows: [] })?.member, 'youtube-lead');
  assert.equal(matchMember('zed', { root: repoRoot, boardRows: [] }), null);
});

