'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
const cli = path.join(repo, 'bin', 'atris.js');
const ax = require('../ax');
const writer1 = require('../lib/writer-1');

test('writer-1 runs three-tier relay (pro Terra gather -> max Neon write -> fast Haiku light edit)', async () => {
  const calls = [];
  const result = await writer1.runWriter1('Write a 3-sentence note about Atris.', {
    cwd: repo,
    taste: 'Plain words. No slop.',
    stageRunner: async (stage) => {
      calls.push({ name: stage.name, tier: stage.tier, engine: stage.engine, model: stage.model });
      if (stage.name === 'gather') {
        return { output: '- Atris CLI runs in Node with zero dependencies.\n- ax switches models fast.', durationMs: 120 };
      }
      if (stage.name === 'write') {
        return {
          output: 'Atris runs in Node with zero extra packages. It wires Neon and Opus directly \u2014 and keeps your repo fast. Switch models mid-chat with one command.',
          durationMs: 340,
        };
      }
      if (stage.name === 'edit') {
        return {
          output: 'Atris runs in Node with zero extra packages. It wires Neon and Opus directly \u2014 and keeps your repo fast. Switch models mid-chat with one command.',
          durationMs: 80,
        };
      }
      throw new Error(`unexpected stage ${stage.name}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'atris:writer-1');
  assert.deepEqual(calls, [
    { name: 'gather', tier: 'pro', engine: 'codex', model: 'gpt-6.1-terra' },
    { name: 'write', tier: 'max', engine: 'agy', model: 'gemini-4-neon-low' },
    { name: 'edit', tier: 'fast', engine: 'atris-fast', model: 'atris:fast' },
  ]);
  assert.equal(result.editGuard.keptEditor, true);
  assert.equal(result.editGuard.diffRatio, 0);
  // Deterministic slop gate strips the em dash and comma-before-and cleanly.
  assert.doesNotMatch(result.output, /\u2014/);
  assert.doesNotMatch(result.output, /,\s+and\b/);
  assert.equal(result.slop.findings.length, 0);
});

test('writer-1 rejects light editor when it over-corrects or rewrites Neon voice', async () => {
  const neonDraft = 'We wired Neon as Atris Max. Terra reads your files fast and Haiku checks grammar without touching voice.';
  const result = await writer1.runWriter1('Draft a short note.', {
    skipGather: true,
    stageRunner: async (stage) => {
      if (stage.name === 'write') return { output: neonDraft, durationMs: 200 };
      if (stage.name === 'edit') {
        return {
          output: 'Introducing our revolutionary ' + 'next-gen' + 'eration platform that ' + 'seam' + 'lessly ' + 'super' + 'charges your entire engineering workflow with ' + 'cutting-' + 'edge AI orchestration.',
          durationMs: 60,
        };
      }
      throw new Error(`unexpected stage ${stage.name}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.editGuard.keptEditor, false);
  assert.ok(result.editGuard.diffRatio > 0.15);
  assert.match(result.editGuard.reason, /over-corrected/);
  assert.equal(result.output, neonDraft);
});

test('writer-1 cleanProseSlop fixes em dashes and comma-joins while preserving inline code and flagging hype', () => {
  const hype = 'seam' + 'lessly';
  const sample = `Keep \`a, and b\` untouched \u2014 but drop hype like ${hype}, and stay direct.`;
  const out = writer1.cleanProseSlop(sample);
  assert.match(out.text, /`a, and b`/);
  assert.doesNotMatch(out.text, /\u2014/);
  assert.doesNotMatch(out.text, new RegExp(`${hype},\\s+and`));
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].rule, 'hype-copy');
});

test('buildSwapHandoff compacts prior turns into a clean model-agnostic handoff block', () => {
  const handoff = writer1.buildSwapHandoff([
    { role: 'user', content: 'Check lib/writer-1.js and ax for the Neon tier.' },
    { role: 'assistant', content: 'Read lib/writer-1.js. Neon maps to max.' },
    { role: 'user', content: 'Now draft the launch post.' },
    { role: 'assistant', content: 'Drafted the launch post in plain English.' },
  ], 'pro', 'max');

  assert.ok(handoff);
  assert.equal(handoff.compactedCount, 4);
  assert.match(handoff.summary, /pro -> max/);
  assert.match(handoff.summary, /lib\/writer-1\.js/);
  assert.match(handoff.summary, /Drafted the launch post/);
});

test('ax resolves neon -> max, terra -> gpt-6.1-terra, writer-1 -> atris:writer-1 and compacts on mid-chat swap', async () => {
  assert.equal(ax.normalizeMode('neon'), 'max');
  assert.equal(ax.normalizeMode('writer-1'), 'writer-1');
  assert.equal(ax.modelForMode('writer-1'), 'atris:writer-1');
  assert.equal(ax.tierLabel('writer-1'), 'Atris Writer-1');

  assert.equal(ax.runChatSlash('/model neon', { mode: 'pro', color: false }).mode, 'max');
  assert.equal(ax.runChatSlash('/model writer-1', { mode: 'pro', color: false }).mode, 'writer-1');
  assert.equal(ax.runChatSlash('/model terra', { mode: 'pro', color: false }).mode, 'model:openai:gpt-6.1-terra');

  const seenHistories = [];
  let buf = '';
  const output = { isTTY: false, write: (chunk) => { buf += String(chunk); } };

  await ax.chat({
    mode: 'pro',
    cwd: repo,
    skipRuntimePreflight: true,
    input: Readable.from([
      'Inspect lib/writer-1.js\n',
      '/model neon\n',
      'Summarize what changed\n',
      '/exit\n',
    ]),
    output,
    turnFunction: async (msg, opts) => {
      seenHistories.push({ mode: opts.mode, msg, history: (opts.history || []).map((h) => ({ ...h })) });
      return { output: `reply to ${msg}`, durationMs: 5, events: [] };
    },
  });

  assert.match(buf, /compacted 2 turns for clean swap/);
  assert.equal(seenHistories.length, 2);
  assert.equal(seenHistories[1].mode, 'max');
  assert.equal(seenHistories[1].history.length, 1);
  assert.match(seenHistories[1].history[0].content, /Clean swap handoff: pro -> max/);
  assert.match(seenHistories[1].history[0].content, /lib\/writer-1\.js/);
});

test('atris member install writer-1 lands every shipped file cleanly and is idempotent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-writer-1-'));
  fs.mkdirSync(path.join(root, 'atris'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const files = [
    'MEMBER.md',
    'MISSION.md',
    'SOUL.md',
    'goals.md',
    'goals.json',
    'context/why.md',
    'skills/writer-1/SKILL.md',
  ];

  const first = spawnSync(process.execPath, [cli, 'member', 'install', 'writer-1'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(first.status, 0, first.stderr);
  for (const rel of files) {
    assert.ok(fs.existsSync(path.join(root, 'atris', 'team', 'writer-1', rel)), `missing ${rel}`);
  }

  const again = spawnSync(process.execPath, [cli, 'member', 'install', 'writer-1'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, 'MEMBER already installed for writer-1\n');
});

test('flow mode skips Terra on pure thoughts, gathers quietly on file refs and locks with Haiku guard', async () => {
  assert.equal(writer1.isLockIntent('lock it'), true);
  assert.equal(writer1.isLockIntent('lock'), true);
  assert.equal(writer1.isLockIntent('drop another thought'), false);
  assert.equal(writer1.needsFactGather('every other AI steals the pen'), false);
  assert.equal(writer1.needsFactGather('check lib/writer-1.js for the cap'), true);

  const flow = writer1.createFlowSession();
  const stageCalls = [];

  const runner = async (stage) => {
    stageCalls.push({ name: stage.name, tier: stage.tier, model: stage.model });
    if (stage.name === 'gather') {
      return { output: '- lib/writer-1.js caps light edits at 15% word diff.', durationMs: 40 };
    }
    if (stage.name === 'write' && stage.prompt.includes('Flow Mode (Lock pass)')) {
      return {
        output: 'Every other AI steals the pen and hands back safe copy.\n\nWe built Flow Mode so Neon keeps you thinking while Terra grabs facts quietly and Haiku checks grammar under a 15% cap.',
        durationMs: 120,
      };
    }
    if (stage.name === 'write') {
      return {
        output: 'Line: Every other AI steals the pen and hands back safe copy.\nNext: What moment made you realize people want a studio producer instead of a ghostwriter?',
        durationMs: 90,
      };
    }
    if (stage.name === 'edit') {
      return {
        output: 'Every other AI steals the pen and hands back safe copy.\n\nWe built Flow Mode so Neon keeps you thinking while Terra grabs facts quietly and Haiku checks grammar under a 15% cap.',
        durationMs: 30,
      };
    }
    throw new Error(`unexpected stage ${stage.name}`);
  };

  // Beat 1: pure human thought -> zero Terra latency, Neon pulls Line + Next.
  const b1 = await writer1.runFlowTurn('every other ai just steals the pen and writes dead corporate copy', flow, {
    cwd: repo,
    taste: 'Plain words.',
    stageRunner: runner,
  });
  assert.equal(b1.ok, true);
  assert.equal(b1.phase, 'beat');
  assert.equal(b1.beatCount, 1);
  assert.equal(b1.line, 'Every other AI steals the pen and hands back safe copy.');
  assert.match(b1.next, /studio producer/);
  assert.deepEqual(stageCalls, [{ name: 'write', tier: 'max', model: 'gemini-4-neon-low' }]);

  // Beat 2: mentions a repo file -> Terra runs quietly in the background.
  const b2 = await writer1.runFlowTurn('check lib/writer-1.js so we cite the real diff cap', flow, {
    cwd: repo,
    taste: 'Plain words.',
    stageRunner: runner,
  });
  assert.equal(b2.beatCount, 2);
  assert.equal(flow.facts.length, 1);
  assert.deepEqual(stageCalls.slice(1), [
    { name: 'gather', tier: 'pro', model: 'gpt-6.1-terra' },
    { name: 'write', tier: 'max', model: 'gemini-4-neon-low' },
  ]);

  // Lock it: Neon weaves human's own beats -> Haiku checks grammar -> zero slop.
  const locked = await writer1.runFlowTurn('lock it', flow, {
    cwd: repo,
    taste: 'Plain words.',
    stageRunner: runner,
  });
  assert.equal(locked.ok, true);
  assert.equal(locked.phase, 'lock');
  assert.equal(locked.editGuard.keptEditor, true);
  assert.equal(locked.slop.findings.length, 0);
  assert.match(locked.output, /Every other AI steals the pen/);
  assert.equal(flow.locked, locked.output);
});

test('ax chat runs multi-turn flow mode and locks draft without backend preflight', async () => {
  assert.equal(ax.normalizeMode('flow'), 'flow');
  assert.equal(ax.modelForMode('flow'), 'atris:writer-1:flow');
  assert.equal(ax.tierLabel('flow'), 'Atris Flow');
  assert.equal(ax.runChatSlash('/model flow', { mode: 'pro', color: false }).mode, 'flow');

  let out = '';
  const output = { isTTY: false, write: (chunk) => { out += String(chunk); } };
  await ax.chat({
    mode: 'flow',
    cwd: repo,
    input: Readable.from([
      'neon feels like sonnet 3.5 all over again\n',
      'lock it\n',
      '/exit\n',
    ]),
    output,
    stageRunner: async (stage) => {
      if (stage.name === 'write' && stage.prompt.includes('Flow Mode (Lock pass)')) {
        return { output: 'Neon feels like Sonnet 3.5 all over again. Now you can run it straight from your terminal.', durationMs: 10 };
      }
      if (stage.name === 'write') {
        return {
          output: 'Line: Neon feels like Sonnet 3.5 all over again.\nNext: What stopped you from switching to Antigravity for it?',
          durationMs: 10,
        };
      }
      if (stage.name === 'edit') {
        return { output: 'Neon feels like Sonnet 3.5 all over again. Now you can run it straight from your terminal.', durationMs: 5 };
      }
      return { output: '', durationMs: 1 };
    },
  });

  assert.match(out, /Atris Flow chat/);
  assert.match(out, /Neon feels like Sonnet 3\.5 all over again\./);
  assert.match(out, /What stopped you from switching to Antigravity for it\?/);
  assert.match(out, /Now you can run it straight from your terminal\./);
});

test('analyzeWritingCraft catches policy tells and computes rhythm stats', () => {
  const prose = [
    '# Heading',
    '',
    'At the end of the day, we should leverage this really great idea \u2014 and move fast.',
    'Here is a plain second sentence that holds up.',
  ].join('\n');
  const craft = writer1.analyzeWritingCraft(prose);
  assert.equal(craft.sentences, 2);
  assert.ok(craft.words >= 20);
  assert.ok(craft.readSeconds >= 1);
  const kinds = new Set(craft.tells.map((t) => t.kind));
  assert.ok(kinds.has('filler'));
  assert.ok(kinds.has('corporate'));
  assert.ok(kinds.has('em-dash'));
  assert.ok(kinds.has('hedge'));
});

test('flow sessions persist to disk, support beats/undo/review and export Written by you record', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-flow-disk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const flow = writer1.createFlowSession('Why Neon Matters', 'why-neon-matters');
  const runner = async (stage) => {
    if (stage.prompt.includes('Peer Reviewer')) {
      return {
        output: 'STRONGEST: Neon keeps your voice alive.\nNOTE: Give one concrete example.\nNOTE: Try saying "use our amazing platform" instead.\nNEXT: Name the exact moment it clicked.',
        durationMs: 12,
      };
    }
    if (stage.prompt.includes('Flow Mode (Lock pass)')) {
      return { output: 'Neon keeps your voice alive. You stay in flow from start to finish.', durationMs: 15 };
    }
    if (stage.name === 'write') {
      return { output: 'Line: Neon keeps your voice alive.\nNext: What moment made that clear?', durationMs: 10 };
    }
    if (stage.name === 'edit') {
      return { output: 'Neon keeps your voice alive. You stay in flow from start to finish.', durationMs: 5 };
    }
    return { output: '', durationMs: 1 };
  };

  await writer1.runFlowTurn('Neon keeps your voice alive.', flow, { cwd: root, persist: true, stageRunner: runner });
  await writer1.runFlowTurn('Tangent to undo.', flow, { cwd: root, persist: true, stageRunner: runner });
  assert.equal(flow.beats.length, 2);

  const beatsView = await writer1.runFlowTurn('beats', flow, { cwd: root, persist: true, stageRunner: runner });
  assert.match(beatsView.output, /2 beats/);

  const undone = await writer1.runFlowTurn('undo', flow, { cwd: root, persist: true, stageRunner: runner });
  assert.equal(undone.beatCount, 1);

  const rev = await writer1.runFlowTurn('review', flow, { cwd: root, persist: true, stageRunner: runner });
  assert.equal(rev.strongestLine, 'Neon keeps your voice alive.');
  // Multi-word quoted replacement note is dropped by anti-rewrite guard!
  assert.deepEqual(rev.notes, ['Give one concrete example.']);
  assert.match(rev.nextMove, /exact moment/);

  const locked = await writer1.runFlowTurn('lock it', flow, { cwd: root, persist: true, stageRunner: runner });
  assert.equal(locked.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'atris', 'writing', 'why-neon-matters', 'flow.json')));
  assert.ok(fs.existsSync(path.join(root, 'atris', 'writing', 'why-neon-matters', 'draft.md')));
  assert.ok(fs.existsSync(path.join(root, 'atris', 'writing', 'why-neon-matters', 'record.md')));

  const recordText = fs.readFileSync(path.join(root, 'atris', 'writing', 'why-neon-matters', 'record.md'), 'utf8');
  assert.match(recordText, /Written by you/);
  assert.match(recordText, /0 pasted/);

  const reloaded = writer1.loadFlowSession('why-neon-matters', root);
  assert.equal(reloaded.beats.length, 1);
  assert.equal(reloaded.locked, locked.output);
});

test('atris write polish respects the 15% over-edit guard and only writes on --apply', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-polish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'note.md');
  fs.writeFileSync(file, 'Every tool steal the pen \u2014 and hands back dead copy.\n', 'utf8');

  const writeCmd = require('../commands/write');
  const stubRunner = async () => ({
    output: 'Every tool steals the pen \u2014 and hands back dead copy.',
    durationMs: 5,
  });

  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const dryCode = await writeCmd.polish(['note.md'], root, { stageRunner: stubRunner });
    assert.equal(dryCode, 0);
    assert.match(fs.readFileSync(file, 'utf8'), /steal the pen/);

    const applyCode = await writeCmd.polish(['note.md', '--apply'], root, { stageRunner: stubRunner });
    assert.equal(applyCode, 0);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), 'Every tool steals the pen and hands back dead copy.');
  } finally {
    console.log = orig;
  }
});
