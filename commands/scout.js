// atris scout — dispatch cheap Haiku subagents for search/context questions.
// Mirrors Claude Code's built-in subagent pattern: read-only, bounded report,
// main session never pays for the exploration.
//
//   atris scout "where is credit deduction wired?"
//   atris scout "q1" "q2" "q3"          # parallel scouts
//   atris scout --dir ../atrisos-web "where is the proxy middleware?"
//   atris scout --model sonnet "..."     # judgment call, not a lookup
//   atris scout --engine fast "..."      # glm-5.2 fast lane, ~1% frontier cost
//   atris scout --engine cursor "..."    # cursor-agent headless
//   atris scout --engine devin "..."     # devin -p (read-only by default)

const { spawn } = require('child_process');
const path = require('path');

const READ_ONLY_TOOLS = [
  'Read', 'Glob', 'Grep',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)',
  'Bash(rg:*)', 'Bash(find:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(atris status:*)', 'Bash(atris task list:*)', 'Bash(atris mission status:*)',
].join(',');

const MODELS = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' };

// Engines share one contract: argv to spawn, and how to read the answer back.
// All run from the target dir; the prompt itself enforces read-only behavior
// for engines that lack a tool allowlist (cursor). devin defaults to read-only.
const ENGINES = {
  claude: {
    argv: (prompt, model) => ['claude', ['-p', prompt, '--model', model, '--allowedTools', READ_ONLY_TOOLS]],
    parse: (out) => out.trim(),
  },
  cursor: {
    argv: (prompt) => ['cursor-agent', ['--trust', '-p', prompt]],
    parse: (out) => out.trim(),
  },
  devin: {
    argv: (prompt) => ['devin', ['-p', '--', prompt]],
    parse: (out) => out.trim(),
  },
  fast: {
    argv: (prompt) => ['atris', ['chat', '--print', prompt]],
    parse: (out) => {
      try {
        const j = JSON.parse(out);
        if (j && typeof j.output === 'string') return j.ok === false ? `fast lane error: ${j.error || j.output}` : j.output.trim();
      } catch (_) { /* not JSON — fall through to raw */ }
      return out.trim();
    },
  },
};

function scoutPrompt(question, dir) {
  return [
    `You are a read-only scout in ${dir}. You NEVER write, edit, or run mutating commands.`,
    `Search order: index files first (atris/MAP.md, atris/TODO.md, README) via targeted reads, then grep. Cheap reads only.`,
    ``,
    `Question: ${question}`,
    ``,
    `Answer in at most 30 lines. Lead with the answer, cite file:line for every claim, list what you did NOT check.`,
  ].join('\n');
}

function runScout(question, { dir, model, engine, timeoutMs }) {
  return new Promise((resolve) => {
    const eng = ENGINES[engine];
    const [cmd, cmdArgs] = eng.argv(scoutPrompt(question, dir), model);
    const child = spawn(cmd, cmdArgs, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ question, ok: false, text: `timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ question, ok: false, text: `failed to spawn ${cmd}: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve({ question, ok: true, text: eng.parse(out) });
      else resolve({ question, ok: false, text: (err.trim() || out.trim() || `exit ${code}`) });
    });
  });
}

async function scoutCommand(argv) {
  const args = [...argv];
  const questions = [];
  let dir = process.cwd();
  let model = MODELS.haiku;
  let engine = 'claude';
  let timeoutMs = 180000;

  while (args.length) {
    const a = args.shift();
    if (a === '--dir') dir = path.resolve(args.shift() || '.');
    else if (a === '--model') model = MODELS[args.shift()] || MODELS.haiku;
    else if (a === '--engine') {
      engine = args.shift() || 'claude';
      if (!ENGINES[engine]) { console.error(`✗ unknown engine "${engine}" (claude|cursor|devin|fast)`); return 1; }
    }
    else if (a === '--timeout') timeoutMs = (parseInt(args.shift(), 10) || 180) * 1000;
    else if (a === '--help' || a === '-h') { showHelp(); return 0; }
    else questions.push(a);
  }

  if (!questions.length) { showHelp(); return 1; }

  const label = engine === 'claude' ? model : engine;
  console.log(`\n  scouting with ${questions.length} ${label} agent${questions.length > 1 ? 's' : ''} in ${dir}\n`);
  const started = Date.now();
  const results = await Promise.all(questions.map((q) => runScout(q, { dir, model, engine, timeoutMs })));

  for (const r of results) {
    console.log(`  ── ${r.ok ? '✓' : '✗'} ${r.question}`);
    console.log(r.text.split('\n').map((l) => `     ${l}`).join('\n'));
    console.log('');
  }
  console.log(`  done in ${Math.round((Date.now() - started) / 1000)}s\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

function showHelp() {
  console.log(`
  atris scout — cheap read-only subagents for search & context questions

  usage:
    atris scout "<question>" ["<question>" ...]     parallel scouts, one per question
    atris scout --dir <path> "<question>"           scout a different repo
    atris scout --model sonnet "<question>"         upgrade the model (default: haiku)
    atris scout --engine fast "<question>"          engine: claude | cursor | devin | fast
    atris scout --timeout 300 "<question>"          seconds per scout (default: 180)

  engines: claude = claude -p with a read-only tool allowlist (default, haiku).
  fast = atris chat --print (glm-5.2 fast lane, needs an atris/ workspace).
  cursor = cursor-agent --trust -p. devin = devin -p (read-only by default).

  scouts are read-only: they answer in ≤30 lines with file:line citations.
`);
}

module.exports = { scoutCommand };
