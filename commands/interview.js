'use strict';

// `atris interview [subject]`: the interlinked 1-on-1. Launches a live Claude
// interview that extracts judgment into a member file (create or amend).
//
//   atris interview            Interview the operator (warm start from logs)
//   atris interview me         Same as above
//   atris interview neo        Re-interview a member about its own logs
//   atris interview darvo      (any atris/team/<slug> works)
//   atris interview "Priya"    Cold-start interview of a new expert → new member
//
// The command gathers context paths, composes the interview brief, and hands
// off to an interactive `claude` session. The conversation IS the product;
// this command just makes sure it opens with what the system already knows.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function findWorkspaceRoot(start) {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'atris'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function today(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function existing(...candidates) {
  return candidates.filter((p) => p && fs.existsSync(p));
}

function showHelp() {
  console.log('');
  console.log('Usage: atris interview [subject]');
  console.log('');
  console.log('The interlinked 1-on-1. A live interview that extracts judgment into a');
  console.log('member file. One question at a time, opens with observed behavior, ends');
  console.log('with the verify question. The transcript becomes a MEMBER.md create/amend.');
  console.log('');
  console.log('  atris interview            Interview the operator (reads recent journal first)');
  console.log('  atris interview <member>   Performance review: member vs its own logs');
  console.log('  atris interview "<Name>"   Cold-start a new expert into a new member');
  console.log('  --help, -h                 Show this help');
  console.log('');
}

function composePrompt(mode, subject, contextPaths, root) {
  const ctx = contextPaths.length
    ? `Read these first (this is what the system already knows — open with an observation from them, never a blank question):\n${contextPaths.map((p) => `- ${p}`).join('\n')}`
    : 'No system data exists for this subject — this is a cold start.';

  const laws = `Rules of conduct (the six laws — non-negotiable):
1. Never render a form. ONE question per turn; the next question comes from the answer.
2. Never ask what the system already knows. Open with an observation, not a blank ask.
3. The verify question is the whole game: "how do you know it worked?" Prefer countable process receipts.
4. Interview a person, not a profession. Hunt the last real instance, actual names, where they paused.
5. Living file. The transcript ends as a MEMBER.md create or amend + immediate commit and push.
6. Arrival, not initiation. Reversible edits land done with the diff shown; question marks only for judgment that is genuinely theirs.
Warmth without glazing: claims that cannot survive a follow-up die politely and stay out of the file.
5-10 questions is a full session. Stop when the verify condition lands.
Full skill (read if present): .claude/skills/interview/SKILL.md · spec: atris/features/md-builder/idea.md`;

  const modes = {
    operator: `Mode: OPERATOR WARM START. Interview the human at the keyboard. Open with the sharpest observed behavior in their recent journal/logs — especially repeated manual actions (unextracted members) and policies their own behavior contradicts. Output: a new member, an amendment, or a policy change.`,
    member: `Mode: MEMBER RE-INTERVIEW (performance review). Subject: the team member "${subject}". Read its folder (MEMBER.md, logs/, now.md, proofs) and interview the human ABOUT it — where it failed, what it should defend, what taste is missing from its file. Honest failure → document the lesson, no penalty. A false "done" is the one unforgivable act. Output: amend atris/team/${subject}/MEMBER.md.`,
    expert: `Mode: COLD START. Subject: a new expert called "${subject}". No system data. Opener: "when someone is stuck, what's the problem where they say 'just ask you'?" (civilian variant: "what are you the designated one for?"). Then last real instance → live method demo → quality bar → verify question. Output: create atris/team/<slug>/MEMBER.md.`,
  };

  return [
    `You are running /interview — the interlinked 1-on-1 (workspace: ${root}).`,
    modes[mode],
    ctx,
    laws,
    `Begin the interview now with your single opening question.`,
  ].join('\n\n');
}

async function interviewCommand(args = [], root = process.cwd()) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return 0;
  }

  const ws = findWorkspaceRoot(root);
  if (!ws) {
    console.error('✗ Not inside an Atris workspace (no atris/ directory found).');
    return 1;
  }

  const subjectRaw = (args.find((a) => !a.startsWith('--')) || 'me').trim();
  const slug = subjectRaw.toLowerCase().replace(/\s+/g, '-');
  const memberDir = path.join(ws, 'atris', 'team', slug);

  let mode;
  let contextPaths = [];

  if (subjectRaw === 'me' || subjectRaw === '') {
    mode = 'operator';
    contextPaths = existing(
      path.join(ws, 'atris', 'logs', '2026', `${today()}.md`),
      path.join(ws, 'atris', 'logs', '2026', `${today(1)}.md`),
      path.join(ws, 'atris', 'now.md'),
      path.join(ws, 'atris', 'TODO.md')
    );
  } else if (fs.existsSync(memberDir)) {
    mode = 'member';
    contextPaths = existing(
      path.join(memberDir, 'MEMBER.md'),
      path.join(memberDir, 'now.md'),
      path.join(memberDir, 'logs'),
      path.join(memberDir, 'proofs'),
      path.join(ws, 'atris', 'logs', '2026', `${today()}.md`)
    );
  } else {
    mode = 'expert';
  }

  const prompt = composePrompt(mode, mode === 'member' ? slug : subjectRaw, contextPaths, ws);

  console.log('');
  console.log(`◈ interview — ${mode === 'operator' ? 'you, from your logs' : mode === 'member' ? `1-on-1 about ${slug}` : `cold start: ${subjectRaw}`}`);
  if (contextPaths.length) console.log(`  context: ${contextPaths.length} source${contextPaths.length > 1 ? 's' : ''} loaded`);
  console.log('');

  const child = spawn('claude', [prompt], { cwd: ws, stdio: 'inherit' });
  return await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code || 0));
    child.on('error', (err) => {
      console.error(`✗ Could not launch claude: ${err.message}`);
      console.error('  Install Claude Code or run the prompt manually:');
      console.log('\n' + prompt + '\n');
      resolve(1);
    });
  });
}

module.exports = { interviewCommand };
