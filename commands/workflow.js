const fs = require('fs');
const path = require('path');
const { getLogPath } = require('../lib/journal');

function wrapWorkflowText(text, width = 76) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];

  const words = normalized.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((current + ' ' + word).length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function printWorkflowBrief(lines) {
  console.log('');
  for (const line of lines) {
    if (!line) {
      console.log('');
      continue;
    }
    for (const wrapped of wrapWorkflowText(line)) {
      console.log(wrapped);
    }
  }
  console.log('');
}

const CONFIDENCE_GATE_LINES = [
  'Confidence Gate:',
  '1) Ask: am I factually confident enough to move this forward?',
  '2) Find loopholes: stale sources, missing owner, weak proof, bad rollback, hidden risk.',
  '3) Patch every known loophole with proof, verifier, owner, rollback, or an explicit blocked note.',
  '4) Only advance when confidence is earned; never use 100% as a vibe.'
];

function printConfidenceGate(indent = '') {
  for (const line of CONFIDENCE_GATE_LINES) console.log(`${indent}${line}`);
}

function buildWorkflowZeroShotPacket() {
  try {
    const { buildPacket } = require('./zero-shot');
    return buildPacket();
  } catch {
    return null;
  }
}

function zeroShotWorkflowLines(packet) {
  if (!packet || !packet.decision || !packet.commands) return [];
  const decision = packet.decision;
  const focus = [decision.selected_ref, decision.selected_title].filter(Boolean).join(' - ') || 'none';
  const route = [decision.lane, decision.horizon, decision.model_tier].filter(Boolean).join(' | ');
  const firstCommand = packet.commands.first_command || packet.commands.next_command || 'atris 0-shot --prompt';
  const lines = [
    '0-shot next move:',
    `- route: ${route || 'unknown'}`,
    `- focus: ${focus}`,
    `- first command: ${firstCommand}`,
    `- menu: ${packet.commands.zero_shot_all || 'atris 0-shot --all'}`,
    `- prompt: ${packet.commands.zero_shot_prompt || 'atris 0-shot --prompt'}`,
  ];
  if (decision.reason) lines.splice(3, 0, `- why: ${decision.reason}`);
  if (decision.owner_action) lines.push(`- owner gate: ${decision.owner_action}`);
  if (decision.safe_agent_action) lines.push(`- agent-safe action: ${decision.safe_agent_action}`);
  return lines;
}

function printWorkflowZeroShot(packet) {
  const lines = zeroShotWorkflowLines(packet);
  if (!lines.length) return;
  console.log('🎯 CURRENT 0-SHOT ROUTE');
  for (const line of lines) console.log(line);
  console.log('');
}

function isWorkflowOwnerGatedZeroShot(packet) {
  const decision = packet && packet.decision;
  return Boolean(decision && (decision.lane === 'owner_gate' || decision.owner_action));
}

function printWorkflowOwnerGateStop(packet, commandName) {
  if (!packet || !packet.decision || !packet.commands) return;
  const decision = packet.decision;
  const commands = packet.commands;
  const route = [decision.lane, decision.horizon, decision.model_tier].filter(Boolean).join(' | ') || 'unknown';
  const focus = [decision.selected_ref, decision.selected_title].filter(Boolean).join(' - ') || 'none';
  const firstCommand = commands.first_command || commands.next_command || 'atris 0-shot --prompt';

  console.log('');
  console.log('0-shot preflight:');
  console.log(`  route: ${route}`);
  console.log(`  focus: ${focus}`);
  if (decision.reason) console.log(`  why: ${decision.reason}`);
  console.log(`  first command: ${firstCommand}`);
  console.log(`  menu: ${commands.zero_shot_all || 'atris 0-shot --all'}`);
  console.log(`  prompt: ${commands.zero_shot_prompt || 'atris 0-shot --prompt'}`);
  if (decision.owner_action) console.log(`  owner gate: ${decision.owner_action}`);
  if (decision.safe_agent_action) console.log(`  agent-safe action: ${decision.safe_agent_action}`);
  console.log('');
  console.log(`Owner-gated 0-shot route detected. I am not starting ${commandName}.`);
  console.log(`Run first: ${firstCommand}`);
  console.log(`Inspect all routes: ${commands.zero_shot_all || 'atris 0-shot --all'}`);
  console.log('');
}

function confidenceGatePrompt(stage) {
  return [
    `Confidence Gate (${stage}):`,
    `- Ask whether you are factually confident enough to advance this ${stage}.`,
    '- List every plausible loophole: stale source, missing owner, weak proof, bad rollback, hidden side effect, ambiguous done condition.',
    '- Patch each loophole with a source read, verifier, proof requirement, owner, rollback, or explicit blocked note.',
    '- Do not claim 100% confidence unless every known loophole is patched, verified, or named as residual risk.'
  ].join('\n');
}

function atris2TurnRequest(payload) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8000,
      path: '/api/atris2/turn',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        // Local-desktop auth: the backend treats localhost requests with a
        // localhost Origin as the free local-desktop user.
        Origin: 'http://localhost:8000'
      }
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          let detail = data;
          try { detail = JSON.parse(data).detail || data; } catch (e) { /* raw body */ }
          const err = new Error(`HTTP ${res.statusCode}: ${detail}`.slice(0, 400));
          err.statusCode = res.statusCode;
          reject(err);
        });
        return;
      }

      // SSE stream: print text deltas live, surface tool calls, capture result.
      let buffer = '';
      let finalResult = null;
      let streamError = null;
      let wroteText = false;
      let idleTimer = null;
      const IDLE_MS = 120000;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          req.destroy();
          reject(new Error(`Stream stalled: no events for ${IDLE_MS / 1000}s`));
        }, IDLE_MS);
      };
      resetIdle();

      const handleEvent = (event) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'text_delta' && event.content) {
          process.stdout.write(event.content);
          wroteText = true;
        } else if (event.type === 'tool_call') {
          const name = event.tool || (event.input && event.input.tool) || 'tool';
          console.log(`\n⚙ ${name}...`);
        } else if (event.type === 'error') {
          streamError = event.error || 'Atris 2 returned an error.';
        } else if (event.type === 'result' && typeof event.result === 'string') {
          finalResult = event.result;
        }
      };

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        resetIdle();
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              handleEvent(JSON.parse(line.slice(6)));
            } catch (e) { /* ignore malformed frame */ }
          }
        }
      });
      res.on('end', () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (streamError) {
          reject(new Error(streamError));
          return;
        }
        resolve({ finalResult, wroteText });
      });
      res.on('error', (err) => {
        if (idleTimer) clearTimeout(idleTimer);
        reject(err);
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runAtris2Local(userInput, atris2Mode) {
  console.log(`🚀 EXECUTING VIA ATRIS 2 ${atris2Mode.toUpperCase()}`);
  console.log('');

  const actualCommand = String(userInput || '').trim().replace(/^2\s+(fast|pro)\b/i, '').trim();
  if (!actualCommand) {
    console.log(`⚠ No command provided after "2 ${atris2Mode}"`);
    console.log(`Usage: atris 2 ${atris2Mode} <your command>`);
    process.exit(1);
  }

  console.log(`Running: ${actualCommand}`);
  console.log('');

  const payload = {
    message: actualCommand,
    workspace_path: process.cwd(),
    model: `atris:${atris2Mode}`
  };

  try {
    let outcome;
    try {
      outcome = await atris2TurnRequest(payload);
    } catch (error) {
      // Backends without local workspace access (prod config) reject the path;
      // retry the same prompt as plain cloud chat.
      if (error.statusCode === 403 && /workspace/i.test(error.message)) {
        outcome = await atris2TurnRequest({ ...payload, workspace_path: null });
      } else {
        throw error;
      }
    }

    if (!outcome.wroteText && outcome.finalResult) {
      process.stdout.write(outcome.finalResult);
    }
    console.log('');
    console.log(`✅ Atris 2 ${atris2Mode} completed`);
  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    console.error(`Atris 2 ${atris2Mode} failed before completion.`);
    console.error(`Refusing to run the prompt as a shell command. Start the backend on port 8000 or retry without "2 ${atris2Mode}".`);
    process.exit(1);
  }
}

async function planAtris(userInput = null) {
  const { loadConfig } = require('../utils/config');
  const { loadCredentials, ensureValidCredentials } = require('../utils/auth');
  const { apiRequestJson } = require('../utils/api');
  const { executeCodeExecution } = require('../utils/claude_sdk');
  const args = process.argv.slice(3);
  const executeFlag = args.includes('--execute');
  const showFull = args.includes('--full') || args.includes('--verbose');

  const config = loadConfig();
  // Auto-enable local execution mode for "2 fast" / "2 pro" product aliases.
  const atris2ModeMatch = userInput && String(userInput).trim().match(/^2\s+(fast|pro)\b/i);
  const atris2Mode = atris2ModeMatch ? atris2ModeMatch[1].toLowerCase() : null;
  const configuredMode = config.execution_mode || 'prompt';
  const executionMode = executeFlag ? 'agent' : (atris2Mode ? 'local' : (configuredMode === 'agent' ? 'agent' : 'prompt'));

  if (executionMode === 'local') {
    await runAtris2Local(userInput, atris2Mode);
    return;
  }

  const targetDir = path.join(process.cwd(), 'atris');
  const navigatorFile = fs.existsSync(path.join(targetDir, 'team', 'navigator', 'MEMBER.md'))
    ? path.join(targetDir, 'team', 'navigator', 'MEMBER.md')
    : path.join(targetDir, 'team', 'navigator.md');
  const personaPath = path.join(targetDir, 'PERSONA.md');
  const mapFilePath = path.join(targetDir, 'MAP.md');
  const featuresReadmePath = path.join(targetDir, 'features', 'README.md');

  if (!fs.existsSync(navigatorFile)) {
    console.log('✗ navigator.md not found. Run "atris init" first.');
    process.exit(1);
  }

  // Read navigator.md
  const navigatorSpec = fs.readFileSync(navigatorFile, 'utf8');

  // Read journal Inbox for context
  const { logFile } = getLogPath();
  let inboxContext = '';

  if (fs.existsSync(logFile)) {
    const logContent = fs.readFileSync(logFile, 'utf8');
    const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
    if (inboxMatch && inboxMatch[1].trim()) {
      inboxContext = inboxMatch[1].trim();
    }
  }

  // Read TODO.md (or legacy TASK_CONTEXTS.md) for current state
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  let taskContexts = '';
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);
  if (taskFilePath) {
    taskContexts = fs.readFileSync(taskFilePath, 'utf8');
  }

  // Detect uncertainty in inbox context (or direct user input)
  const uncertaintySignals = ['not sure', 'maybe', 'but ', 'thinking about', 'uncertain', 'unclear', 'unsure', 'don\'t know'];
  const combinedContext = [userInput, inboxContext].filter(Boolean).join('\n');
  const hasUncertainty = combinedContext && uncertaintySignals.some(signal =>
    combinedContext.toLowerCase().includes(signal)
  );

  const taskSourcePath = taskFilePath ? path.relative(process.cwd(), taskFilePath) : null;
  const journalPath = path.relative(process.cwd(), logFile);
  const navigatorPath = path.relative(process.cwd(), navigatorFile);
  const personaFileRef = fs.existsSync(personaPath) ? path.relative(process.cwd(), personaPath) : null;
  const mapFileRef = fs.existsSync(mapFilePath) ? path.relative(process.cwd(), mapFilePath) : null;
  const featuresReadmeRef = fs.existsSync(featuresReadmePath) ? path.relative(process.cwd(), featuresReadmePath) : null;
  const mapIsPlaceholder = (() => {
    if (!fs.existsSync(mapFilePath)) return false;
    try {
      const content = fs.readFileSync(mapFilePath, 'utf8').toLowerCase();
      return content.includes('generated by your ai agent after reading atris.md')
        || content.includes('run your ai agent with atris.md to populate this file');
    } catch {
      return false;
    }
  })();
  const inboxCount = inboxContext
    ? inboxContext
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return t.startsWith('- ') && t.length > 2;
        })
        .length
    : 0;
  const zeroShotPacket = buildWorkflowZeroShotPacket();
  if (isWorkflowOwnerGatedZeroShot(zeroShotPacket)) {
    printWorkflowOwnerGateStop(zeroShotPacket, 'plan');
    return;
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Plan — Navigator Agent Activated                      │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  // Show suggestion if uncertainty detected
  if (hasUncertainty) {
    console.log('💡 Suggestion:');
    console.log('   Sounds like you\'re exploring options.');
    console.log('   Try `atris brainstorm` first for conversational exploration,');
    console.log('   then run `atris plan` when ready to commit.');
    console.log('');
    console.log('   Or continue with plan if you prefer. Your call.');
    console.log('');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('');
  }

  if (userInput) {
    console.log('🎯 DIRECT REQUEST:');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(userInput);
    console.log('');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('');
  }
  console.log('📁 CONTEXT FILES (agent should read):');
  console.log(`- Navigator spec: ${navigatorPath}`);
  console.log(`- Persona: ${personaFileRef || 'atris/PERSONA.md (missing)'}`);
  const mapDisplay = mapFileRef
    ? `${mapFileRef}${mapIsPlaceholder ? ' (placeholder — generate first)' : ''}`
    : 'atris/MAP.md (missing)';
  console.log(`- MAP: ${mapDisplay}`);
  console.log(`- TODO: ${taskSourcePath || 'atris/TODO.md (missing)'}`);
  console.log(`- Features index: ${featuresReadmeRef || 'atris/features/README.md (missing)'}`);
  const lessonsPath = path.join(targetDir, 'lessons.md');
  const lessonsRef = fs.existsSync(lessonsPath) ? path.relative(process.cwd(), lessonsPath) : null;
  console.log(`- Lessons: ${lessonsRef || 'atris/lessons.md (none yet)'}`);
  console.log(`- Journal (today): ${journalPath}`);

  // Show top learnings if available
  try {
    const { loadLearnings } = require('../lib/learnings');
    const learnings = loadLearnings().filter(e => e._effectiveConfidence >= 7 && e.insight !== '[REMOVED]').slice(0, 3);
    if (learnings.length > 0) {
      console.log('');
      console.log('🧠 Prior learnings (high confidence):');
      for (const l of learnings) {
        console.log(`  [${l._effectiveConfidence}/10] ${l.type}/${l.key}: ${l.insight}`);
      }
    }
  } catch {}

  console.log('');
  console.log(`📥 Inbox items: ${inboxCount}`);
  console.log('');
  printWorkflowZeroShot(zeroShotPacket);

  if (showFull) {
    console.log('📋 NAVIGATOR SPEC (full):');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(navigatorSpec);
    console.log('');
    console.log('📥 INBOX CONTEXT (full):');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(inboxContext || '(No items in Inbox)');
    console.log('');
    console.log('📝 TODO.md (full):');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(taskContexts || '(No TODO content)');
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 COPY/PASTE PROMPT FOR YOUR CODING AGENT:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('You are the Navigator.');
  console.log('');
  console.log('Read these files:');
  console.log(`- ${navigatorPath}`);
  if (personaFileRef) console.log(`- ${personaFileRef}`);
  if (mapFileRef) console.log(`- ${mapFileRef}`);
  if (taskSourcePath) console.log(`- ${taskSourcePath}`);
  if (featuresReadmeRef) console.log(`- ${featuresReadmeRef}`);
  if (lessonsRef) console.log(`- ${lessonsRef}`);
  console.log(`- ${journalPath}`);
  console.log('');
  const zeroShotPromptLines = zeroShotWorkflowLines(zeroShotPacket);
  if (zeroShotPromptLines.length > 0) {
    console.log('Before workflow, inspect current 0-shot state:');
    for (const line of zeroShotPromptLines) console.log(line);
    console.log('If owner-gated, do only the agent-safe action and do not write tasks or accept.');
    console.log('');
  }
  if (!mapFileRef || mapIsPlaceholder) {
    console.log('Note: If `atris/MAP.md` is missing or placeholder, generate it from `atris/atris.md` before writing tasks.');
    console.log('');
  }
  if (userInput) {
    console.log('Direct request:');
    console.log(userInput);
    console.log('');
  }
  console.log('Workflow:');
  console.log('1) ASCII visualize + wait for approval');
  console.log('2) Run the Confidence Gate before writing tasks');
  printConfidenceGate('   ');
  console.log('3) Write tasks to atris/TODO.md under ## Backlog');
  console.log('   Format: - **T#:** Description [explore|execute]');
  console.log('4) Log to atris/team/navigator/journal/YYYY-MM-DD.md');
  console.log('   (Task, Delivered, User reaction, Pattern)');
  if (atris2Mode) {
    console.log('5) EXECUTE MODE ENABLED: Will execute tasks directly.');
  } else {
    console.log('5) Stop. Do NOT execute (run `atris do` to build).');
  }
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💡 After planning: Run "atris do" to execute the build');
  if (!showFull) {
    console.log('   Tip: `atris plan --full` prints full spec/context for copy/paste.');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Check execution mode
  if (executionMode === 'agent') {
    // Agent mode: execute via backend API
    if (!config.agent_id) {
      throw new Error('No agent selected. Run "atris agent" first.');
    }
    const ensured = await ensureValidCredentials(apiRequestJson);
    if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
      throw new Error('Not logged in. Run "atris login" first.');
    }
    if (ensured.error) {
      throw new Error(`Authentication failed: ${ensured.detail || ensured.error}. Run "atris login" to re-authenticate.`);
    }
    const credentials = ensured.credentials;

    // Build system prompt
    let systemPrompt = '';
    if (navigatorSpec) {
      systemPrompt += navigatorSpec + '\n\n';
    }

    // Reference MAP.md and PERSONA.md
    if (fs.existsSync(personaPath)) {
      systemPrompt += '## PERSONA.md\n' + fs.readFileSync(personaPath, 'utf8') + '\n\n';
    }

    if (mapFileRef) {
      systemPrompt += `## MAP.md\nRead this file for file:line references: ${mapFileRef}\n\n`;
    }

    // Build user prompt with context
    let userPrompt = `You are the Navigator. Take ideas from Inbox → break them down into perfect, manageable tasks.\n\n`;
    userPrompt += `⚠️ CRITICAL: You MUST create visualizations BEFORE writing tasks!\n\n`;

    if (userInput) {
      userPrompt += `## DIRECT REQUEST:\n${userInput}\n\n`;
    }

    if (inboxContext) {
      userPrompt += `## INBOX CONTEXT:\n${inboxContext}\n\n`;
    } else {
      userPrompt += `## INBOX CONTEXT:\n(No items in Inbox - check logs/YYYY/YYYY-MM-DD.md for inbox items)\n\n`;
    }

    if (taskContexts) {
      userPrompt += `## CURRENT TODO.md:\n${taskContexts}\n\n`;
    }

    userPrompt += `Your job (execute these steps):\n\n`;
    userPrompt += `STEP 1: Generate ASCII visualizations for user approval\n`;
    userPrompt += `   Create diagrams showing architecture, flows, schemas, UI/UX.\n`;
    userPrompt += `   SHOW these diagrams and wait for approval before proceeding.\n\n`;
    userPrompt += `STEP 2: Run the Confidence Gate before writing tasks\n`;
    userPrompt += confidenceGatePrompt('plan') + `\n\n`;
    userPrompt += `STEP 3: Break approved ideas into concrete tasks\n`;
    userPrompt += `   - Each task should be: Specific, Measurable, Actionable\n`;
    userPrompt += `   - Include file:line references from MAP.md\n`;
    userPrompt += `   - List dependencies between tasks\n`;
    userPrompt += `   - Add acceptance criteria for each task\n\n`;
    userPrompt += `STEP 4: Write tasks to atris/TODO.md\n`;
    userPrompt += `   - Add to ## Backlog section\n`;
    userPrompt += `   - Format: - **T#:** Description [explore|execute]\n`;
    userPrompt += `   - Each task: one job, clear exit condition\n`;
    userPrompt += `   - Include file:line references from MAP.md\n\n`;
    userPrompt += `STEP 5: Log to your journal\n`;
    userPrompt += `   - Write to atris/team/navigator/journal/YYYY-MM-DD.md\n`;
    userPrompt += `   - Include: Task, Delivered, User reaction, Pattern\n`;
    userPrompt += `   - Your journal is how you learn — record what worked\n\n`;
    userPrompt += `Start planning now. Read MAP.md for file references.`;

    console.log('');
    console.log('🤖 AGENT MODE: Executing via backend API...');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Execute via API
    try {
      await executeCodeExecution({
        prompt: userPrompt,
        allowedTools: ['Read', 'Write', 'Edit'], // Navigator needs to write TODO.md
        permissionMode: 'default',
        maxTurns: 15,
        systemPrompt,
        workingDirectory: process.cwd(),
        agentId: config.agent_id,
        token: credentials.token,
        onMessage: (data) => {
          if (data.type === 'text' && data.content) {
            process.stdout.write(data.content);
          } else if (data.type === 'tool_use') {
            console.log(`\n🛠️  [${data.tool || data.tool_name}] ${JSON.stringify(data.input || data.tool_input || {}).substring(0, 100)}`);
          } else if (data.type === 'tool_result') {
            const result = data.result || data.content || '';
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const preview = resultStr.substring(0, 200);
            console.log(`\n✅ [Result] ${preview}${resultStr.length > 200 ? '...' : ''}`);
          } else if (data.type === 'error') {
            console.error(`\n❌ Error: ${data.error}`);
          } else if (data.type === 'result') {
            if (data.result) {
              console.log(`\n🎯 [Final] ${data.result}`);
            }
            if (data.duration_ms) {
              console.log(`⏱️  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
            }
            if (data.cost_usd) {
              console.log(`💰 Cost: $${data.cost_usd.toFixed(4)}`);
            }
          }
        },
        onError: (error) => {
          console.error(`\n❌ Execution error: ${error.message}`);
        },
      });

      console.log('\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
      console.log('💡 After planning: Run "atris do" to execute tasks');
      console.log('');
    } catch (error) {
      console.error(`\n✗ Agent execution failed: ${error.message}`);
      throw error;
    }
  }
  // Prompt mode continues with existing output (already logged above)
}

async function doAtris() {
  const { loadConfig } = require('../utils/config');
  const { loadCredentials, ensureValidCredentials } = require('../utils/auth');
  const { apiRequestJson } = require('../utils/api');
  const { executeCodeExecution } = require('../utils/claude_sdk');
  const args = process.argv.slice(3);
  const executeFlag = args.includes('--execute');
  const showFull = args.includes('--full') || args.includes('--verbose');

  const config = loadConfig();
  const executionMode = executeFlag ? 'agent' : (config.execution_mode || 'prompt');

  const cwd = process.cwd();
  const targetDir = path.join(cwd, 'atris');
  const executorFile = fs.existsSync(path.join(targetDir, 'team', 'executor', 'MEMBER.md'))
    ? path.join(targetDir, 'team', 'executor', 'MEMBER.md')
    : path.join(targetDir, 'team', 'executor.md');

  if (!fs.existsSync(executorFile)) {
    console.log('✗ executor.md not found. Run "atris init" first.');
    process.exit(1);
  }

  // Load project profile for context
  let context = 'ROOT';
  let profile = null;
  const profileFile = path.join(targetDir, '.project-profile.json');
  if (fs.existsSync(profileFile)) {
    try {
      profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      // Use profile type as context (e.g., 'nodejs', 'python', 'knowledge-base')
      context = profile.type.toUpperCase();
      if (profile.framework !== 'none') {
        context += `/${profile.framework.toUpperCase()}`;
      }
    } catch (e) {
      // Fallback to ROOT if profile parse fails
      context = 'ROOT';
    }
  }

  // Load executor spec
  const executorSpec = fs.readFileSync(executorFile, 'utf8');

  // Load PERSONA.md
  const personaFile = path.join(targetDir, 'PERSONA.md');
  let persona = '';
  if (fs.existsSync(personaFile)) {
    persona = fs.readFileSync(personaFile, 'utf8');
  }

  // Reference MAP.md (agents read on-demand)
  const mapFile = path.join(targetDir, 'MAP.md');
  const mapPath = fs.existsSync(mapFile) ? path.relative(process.cwd(), mapFile) : null;
  const mapIsPlaceholder = (() => {
    if (!fs.existsSync(mapFile)) return false;
    try {
      const content = fs.readFileSync(mapFile, 'utf8').toLowerCase();
      return content.includes('generated by your ai agent after reading atris.md')
        || content.includes('run your ai agent with atris.md to populate this file');
    } catch {
      return false;
    }
  })();

  // Load tasks from TODO.md (generic - no hardcoded paths, legacy TASK_CONTEXTS.md supported)
  let tasksContent = '';
  let taskSource = '';
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);
  if (taskFilePath) {
    tasksContent = fs.readFileSync(taskFilePath, 'utf8');
    taskSource = fs.existsSync(todoFile) ? 'atris/TODO.md' : 'atris/TASK_CONTEXTS.md';
  }

  if (!taskSource) {
    taskSource = 'atris/TODO.md';
  }

  // All tasks available (no tag filtering)
  const filteredTasks = tasksContent;

  const executorPath = path.relative(process.cwd(), executorFile);
  const personaFileRef = fs.existsSync(personaFile) ? path.relative(process.cwd(), personaFile) : null;
  const taskSourcePath = taskFilePath ? path.relative(process.cwd(), taskFilePath) : null;
  const featuresReadmePath = path.join(targetDir, 'features', 'README.md');
  const featuresReadmeRef = fs.existsSync(featuresReadmePath) ? path.relative(process.cwd(), featuresReadmePath) : null;

  let featureBuildPlanRefs = [];
  const featuresDir = path.join(targetDir, 'features');
  if (fs.existsSync(featuresDir)) {
    try {
      featureBuildPlanRefs = fs
        .readdirSync(featuresDir)
        .filter((name) => !name.startsWith('_'))
        .filter((name) => {
          const full = path.join(featuresDir, name);
          try {
            return fs.statSync(full).isDirectory();
          } catch {
            return false;
          }
        })
        .map((name) => path.join(featuresDir, name, 'build.md'))
        .filter((buildPath) => fs.existsSync(buildPath))
        .map((buildPath) => path.relative(process.cwd(), buildPath));
    } catch {
      featureBuildPlanRefs = [];
    }
  }

  let workspaceSummary = null;
  try {
    const { loadContext } = require('../lib/state-detection');
    workspaceSummary = loadContext(cwd);
  } catch {
    workspaceSummary = null;
  }
  const zeroShotPacket = buildWorkflowZeroShotPacket();
  if (isWorkflowOwnerGatedZeroShot(zeroShotPacket)) {
    printWorkflowOwnerGateStop(zeroShotPacket, 'do');
    return;
  }

  // Prompt-mode output (keep concise by default)
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Do — Executor Agent Activated                         │');
  console.log(`│ Context: ${context}                                           │`);
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  console.log('📁 CONTEXT FILES (agent should read):');
  console.log(`- Executor spec: ${executorPath}`);
  console.log(`- Persona: ${personaFileRef || 'atris/PERSONA.md (missing)'}`);
  const mapDisplay = mapPath
    ? `${mapPath}${mapIsPlaceholder ? ' (placeholder — generate first)' : ''}`
    : 'atris/MAP.md (missing)';
  console.log(`- MAP: ${mapDisplay}`);
  console.log(`- TODO: ${taskSourcePath || 'atris/TODO.md (missing)'}`);
  console.log(`- Features index: ${featuresReadmeRef || 'atris/features/README.md (missing)'}`);
  console.log('');
  printWorkflowZeroShot(zeroShotPacket);

  // Show top learnings during execution
  try {
    const { loadLearnings } = require('../lib/learnings');
    const learnings = loadLearnings().filter(e => e._effectiveConfidence >= 7 && e.insight !== '[REMOVED]').slice(0, 3);
    if (learnings.length > 0) {
      console.log('');
      console.log('🧠 Prior learnings (apply during build):');
      for (const l of learnings) {
        console.log(`  [${l._effectiveConfidence}/10] ${l.type}/${l.key}: ${l.insight}`);
      }
    }
  } catch {}

  console.log('');

  const backlogCount = workspaceSummary && Array.isArray(workspaceSummary.backlogTasks)
    ? workspaceSummary.backlogTasks.length
    : 0;
  const inProgressCount = workspaceSummary && Array.isArray(workspaceSummary.inProgressFeatures)
    ? workspaceSummary.inProgressFeatures.length
    : 0;

  if (inProgressCount > 0) {
    console.log(`🔨 In-progress features: ${workspaceSummary.inProgressFeatures.join(', ')}`);
  }
  console.log(`🧱 Feature build plans found: ${featureBuildPlanRefs.length}`);
  if (featureBuildPlanRefs.length > 0) {
    featureBuildPlanRefs.slice(0, 3).forEach((ref) => console.log(`- ${ref}`));
    if (featureBuildPlanRefs.length > 3) {
      console.log(`- ... (+${featureBuildPlanRefs.length - 3} more)`);
    }
  }
  console.log(`📋 Backlog tasks: ${backlogCount}`);
  console.log('');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 COPY/PASTE PROMPT FOR YOUR CODING AGENT:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('You are the Executor.');
  console.log('');
  console.log('Read these files:');
  console.log(`- ${executorPath}`);
  if (personaFileRef) console.log(`- ${personaFileRef}`);
  if (mapPath) console.log(`- ${mapPath}`);
  if (taskSourcePath) console.log(`- ${taskSourcePath}`);
  if (featuresReadmeRef) console.log(`- ${featuresReadmeRef}`);
  console.log('');
  const zeroShotPromptLines = zeroShotWorkflowLines(zeroShotPacket);
  if (zeroShotPromptLines.length > 0) {
    console.log('Before workflow, inspect current 0-shot state:');
    for (const line of zeroShotPromptLines) console.log(line);
    console.log('If owner-gated, do only the agent-safe action and do not claim, mutate, or accept.');
    console.log('');
  }
  if (!mapPath || mapIsPlaceholder) {
    console.log('Note: If `atris/MAP.md` is missing or placeholder, generate it from `atris/atris.md` before navigating the codebase.');
    console.log('');
  }
  console.log('Workflow:');
  console.log('1) Start with the 0-shot first command above.');
  console.log('   If it is owner-gated, do only the read-only agent-safe action and stop.');
  console.log('2) Otherwise, read atris/TODO.md — claim next unclaimed Backlog task');
  console.log('   Move to ## In Progress: add "Claimed by: executor at YYYY-MM-DD HH:MM"');
  console.log('3) Run the Confidence Gate against the task before editing');
  printConfidenceGate('   ');
  console.log('4) Execute step-by-step. Run tests as you go.');
  console.log('5) Before completion, rerun the gate against proof and residual risk');
  console.log('6) When done, move task to ## Completed');
  console.log('7) Log to atris/team/executor/journal/YYYY-MM-DD.md');
  console.log('   (Task, Delivered, Errors hit, Learned)');
  console.log('');
  console.log('⛔ Do NOT plan — just execute what\'s written.');
  console.log('');

  if (showFull) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📎 APPENDIX (full context dumps):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    if (persona) {
      console.log('👤 PERSONA.md (full):');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(persona);
      console.log('');
    }

    console.log('🔧 EXECUTOR SPEC (full):');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(executorSpec);
    console.log('');

    if (filteredTasks) {
      console.log(`📋 TASKS TO EXECUTE (full, from ${taskSource}):`);
      console.log('─────────────────────────────────────────────────────────────');
      console.log(filteredTasks);
      console.log('');
    }

  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💡 Next: Run "atris review" after execution');
  if (!showFull) {
    console.log('   Tip: `atris do --full` prints full spec/context for copy/paste.');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Check execution mode
  if (executionMode === 'agent') {
    // Agent mode: execute via backend API
    if (!config.agent_id) {
      throw new Error('No agent selected. Run "atris agent" first.');
    }
    const ensured = await ensureValidCredentials(apiRequestJson);
    if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
      throw new Error('Not logged in. Run "atris login" first.');
    }
    if (ensured.error) {
      throw new Error(`Authentication failed: ${ensured.detail || ensured.error}. Run "atris login" to re-authenticate.`);
    }
    const credentials = ensured.credentials;

    // Build system prompt
    let systemPrompt = '';
    if (executorSpec) {
      systemPrompt += executorSpec + '\n\n';
    }
    if (persona) {
      systemPrompt += '## PERSONA.md\n' + persona + '\n\n';
    }
    if (mapPath) {
      systemPrompt += `## MAP.md\nRead this file for file:line references: ${mapPath}\n\n`;
    }
    if (profile) {
      systemPrompt += `## PROJECT CONTEXT\nType: ${context}\nProfile: ${JSON.stringify(profile, null, 2)}\n\n`;
    }

    // Build user prompt with context
    let userPrompt = `⚠️ CRITICAL: Execute tasks NOW. Use file tools to edit code, terminal to run commands.\n\n`;
    userPrompt += `You are the Executor. Get it done, precisely, following instructions perfectly.\n\n`;

    if (filteredTasks) {
      userPrompt += `## TASKS TO EXECUTE (from ${taskSource}):\n${filteredTasks}\n\n`;
    } else {
      userPrompt += `## TASKS TO EXECUTE:\n(No tasks found - check TODO.md)\n\n`;
    }

    userPrompt += `Your process (EXECUTE these steps):\n`;
    userPrompt += `1. Read tasks from TODO.md (shown above)\n`;
    userPrompt += `2. For each task: Show ASCII visualization first (especially complex changes)\n`;
    userPrompt += `3. Run the Confidence Gate before editing\n`;
    userPrompt += confidenceGatePrompt('do') + `\n`;
    userPrompt += `4. Execute task: Use file edit tools, terminal commands, etc.\n`;
    userPrompt += `5. Before completion, rerun the gate against proof and residual risk\n`;
    userPrompt += `6. Move task to ## Completed in TODO.md\n`;
    userPrompt += `7. Log to atris/team/executor/journal/YYYY-MM-DD.md\n`;
    userPrompt += `   (Task, Delivered, Errors hit, Learned)\n`;
    userPrompt += `8. Use MAP.md to navigate codebase\n\n`;
    userPrompt += `DO NOT just describe what you would do - actually edit files and execute commands!\n`;
    userPrompt += `Context: ${context}\n`;
    userPrompt += `Start executing tasks now.`;

    console.log('');
    console.log('🤖 AGENT MODE: Executing via backend API...');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Execute via API
    try {
      await executeCodeExecution({
        prompt: userPrompt,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash'], // Executor needs all tools
        permissionMode: 'default',
        maxTurns: 20,
        systemPrompt,
        workingDirectory: process.cwd(),
        agentId: config.agent_id,
        token: credentials.token,
        onMessage: (data) => {
          if (data.type === 'text' && data.content) {
            process.stdout.write(data.content);
          } else if (data.type === 'tool_use') {
            console.log(`\n🛠️  [${data.tool || data.tool_name}] ${JSON.stringify(data.input || data.tool_input || {}).substring(0, 100)}`);
          } else if (data.type === 'tool_result') {
            const result = data.result || data.content || '';
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const preview = resultStr.substring(0, 200);
            console.log(`\n✅ [Result] ${preview}${resultStr.length > 200 ? '...' : ''}`);
          } else if (data.type === 'error') {
            console.error(`\n❌ Error: ${data.error}`);
          } else if (data.type === 'result') {
            if (data.result) {
              console.log(`\n🎯 [Final] ${data.result}`);
            }
            if (data.duration_ms) {
              console.log(`⏱️  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
            }
            if (data.cost_usd) {
              console.log(`💰 Cost: $${data.cost_usd.toFixed(4)}`);
            }
          }
        },
        onError: (error) => {
          console.error(`\n❌ Execution error: ${error.message}`);
        },
      });

      console.log('\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
    } catch (error) {
      console.error(`\n✗ Agent execution failed: ${error.message}`);
      throw error;
    }
  }
  // Prompt mode continues with existing output (already logged above)
}

async function reviewAtris() {
  const { loadConfig } = require('../utils/config');
  const { loadCredentials, ensureValidCredentials } = require('../utils/auth');
  const { apiRequestJson } = require('../utils/api');
  const { executeCodeExecution } = require('../utils/claude_sdk');
  const args = process.argv.slice(3);
  const executeFlag = args.includes('--execute');
  const showFull = args.includes('--full') || args.includes('--verbose');
  const wantsTaskJson = args.includes('--json');

  if (!executeFlag && !showFull) {
    const forwarded = ['reviews', ...args.filter(arg => !['--execute', '--full', '--verbose'].includes(arg))];
    const { run: runTaskCommand } = require('./task');
    if (!wantsTaskJson) {
      printWorkflowBrief([
        'Atris Review is the human checkpoint for proof-ready work.',
        'Accept only when the proof is real; revise when the claim is vague, stale, or too narrow.',
        'Agents can add review proof here, but XP waits for human accept.',
      ]);
    }
    await runTaskCommand(forwarded);
    if (!wantsTaskJson) {
      printWorkflowBrief([
        'Need the legacy Validator prompt? Run `atris review --verbose`.',
      ]);
    }
    return;
  }

  const config = loadConfig();
  const executionMode = executeFlag ? 'agent' : (config.execution_mode || 'prompt');

  const targetDir = path.join(process.cwd(), 'atris');
  const validatorFile = fs.existsSync(path.join(targetDir, 'team', 'validator', 'MEMBER.md'))
    ? path.join(targetDir, 'team', 'validator', 'MEMBER.md')
    : path.join(targetDir, 'team', 'validator.md');

  if (!fs.existsSync(validatorFile)) {
    console.log('✗ validator.md not found. Run "atris init" first.');
    process.exit(1);
  }

  const zeroShotPacket = buildWorkflowZeroShotPacket();
  if (isWorkflowOwnerGatedZeroShot(zeroShotPacket)) {
    printWorkflowOwnerGateStop(zeroShotPacket, 'review');
    return;
  }

  // Read validator.md
  const validatorSpec = fs.readFileSync(validatorFile, 'utf8');

  // Read project-specific testing guide if it exists (optional - projects can add their own)
  // Checks common locations: root, backend/, atris/ directories
  let testingGuide = '';
  let testingGuidePath = null;
  const possiblePaths = [
    path.join(process.cwd(), 'AGENT_TESTING_GUIDE.md'),
    path.join(process.cwd(), 'TESTING_GUIDE.md'),
    path.join(process.cwd(), 'atris', 'TESTING_GUIDE.md'),
  ];
  for (const guidePath of possiblePaths) {
    if (fs.existsSync(guidePath)) {
      testingGuide = fs.readFileSync(guidePath, 'utf8');
      testingGuidePath = guidePath;
      break;
    }
  }

  // Read TODO.md (or legacy TASK_CONTEXTS.md)
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  let taskContexts = '';
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);
  if (taskFilePath) {
    taskContexts = fs.readFileSync(taskFilePath, 'utf8');
  }

  // Read journal for timestamp context (History)
  const { logFile, dateFormatted } = getLogPath();
  let journalHistory = '';

  // Load today's log
  if (fs.existsSync(logFile)) {
    journalHistory += `## TODAY (${dateFormatted}):\n` + fs.readFileSync(logFile, 'utf8') + '\n\n';
  }

  // Load previous 3 days of logs for Drift Detection
  // (We need to find them in the logs directory)
  const targetLogsDir = path.join(targetDir, 'logs');
  if (fs.existsSync(targetLogsDir)) {
    // Simple recursive search for last 3 .md files
    const allLogs = [];
    const yearDirs = fs.readdirSync(targetLogsDir).filter(d => /^\d{4}$/.test(d));
    for (const year of yearDirs) {
      const yearPath = path.join(targetLogsDir, year);
      if (fs.statSync(yearPath).isDirectory()) {
        const files = fs.readdirSync(yearPath).filter(f => f.endsWith('.md') && f !== path.basename(logFile));
        files.forEach(f => allLogs.push(path.join(yearPath, f)));
      }
    }
    // Sort desc, take top 3
    allLogs.sort().reverse();
    const recentLogs = allLogs.slice(0, 3);

    if (recentLogs.length > 0) {
      journalHistory += `## RECENT HISTORY (Drift Check):\n`;
      for (const log of recentLogs) {
        journalHistory += `--- ${path.basename(log)} ---\n`;
        journalHistory += fs.readFileSync(log, 'utf8').substring(0, 1000) + '\n... (truncated)\n\n'; // Read first 1kb
      }
    }
  }

  const mapFile = path.join(targetDir, 'MAP.md');
  const mapPath = fs.existsSync(mapFile) ? path.relative(process.cwd(), mapFile) : null;
  const mapIsPlaceholder = (() => {
    if (!fs.existsSync(mapFile)) return false;
    try {
      const content = fs.readFileSync(mapFile, 'utf8').toLowerCase();
      return content.includes('generated by your ai agent after reading atris.md')
        || content.includes('run your ai agent with atris.md to populate this file');
    } catch {
      return false;
    }
  })();

  const validatorPath = path.relative(process.cwd(), validatorFile);
  const todoPathRef = taskFilePath ? path.relative(process.cwd(), taskFilePath) : null;
  const journalPathRef = path.relative(process.cwd(), logFile);
  const personaPath = path.join(targetDir, 'PERSONA.md');
  const personaRef = fs.existsSync(personaPath) ? path.relative(process.cwd(), personaPath) : null;
  const testingGuideRef = testingGuidePath ? path.relative(process.cwd(), testingGuidePath) : null;

  const featuresReadmePath = path.join(targetDir, 'features', 'README.md');
  const featuresReadmeRef = fs.existsSync(featuresReadmePath) ? path.relative(process.cwd(), featuresReadmePath) : null;

  let featureValidateRefs = [];
  const featuresDir = path.join(targetDir, 'features');
  if (fs.existsSync(featuresDir)) {
    try {
      featureValidateRefs = fs
        .readdirSync(featuresDir)
        .filter((name) => !name.startsWith('_'))
        .filter((name) => {
          const full = path.join(featuresDir, name);
          try {
            return fs.statSync(full).isDirectory();
          } catch {
            return false;
          }
        })
        .map((name) => path.join(featuresDir, name, 'validate.md'))
        .filter((validatePath) => fs.existsSync(validatePath))
        .map((validatePath) => path.relative(process.cwd(), validatePath));
    } catch {
      featureValidateRefs = [];
    }
  }

  const mapDisplay = mapPath
    ? `${mapPath}${mapIsPlaceholder ? ' (placeholder — generate first)' : ''}`
    : 'atris/MAP.md (missing)';

  if (showFull) {
    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ Atris Review — Validator Agent Activated                    │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');

    console.log('📁 CONTEXT FILES (agent should read):');
    console.log(`- Validator spec: ${validatorPath}`);
    console.log(`- Testing guide: ${testingGuideRef || '(none found)'}`);
    console.log(`- Persona: ${personaRef || 'atris/PERSONA.md (missing)'}`);
    console.log(`- MAP: ${mapDisplay}`);
    console.log(`- TODO: ${todoPathRef || 'atris/TODO.md (missing)'}`);
    console.log(`- Journal (today): ${journalPathRef}`);
    console.log(`- Features index: ${featuresReadmeRef || 'atris/features/README.md (missing)'}`);
    console.log('');

    console.log(`🧪 Feature validate scripts found: ${featureValidateRefs.length}`);
    if (featureValidateRefs.length > 0) {
      featureValidateRefs.slice(0, 3).forEach((ref) => console.log(`- ${ref}`));
      if (featureValidateRefs.length > 3) {
        console.log(`- ... (+${featureValidateRefs.length - 3} more)`);
      }
    }
    console.log('');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 COPY/PASTE PROMPT FOR YOUR CODING AGENT:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  } else {
    const readinessBits = [
      `MAP is ${mapPath ? 'present' : 'missing'}`,
      `TODO is ${todoPathRef ? 'present' : 'missing'}`,
      `${featureValidateRefs.length} feature validate script${featureValidateRefs.length === 1 ? '' : 's'} ${featureValidateRefs.length === 1 ? 'is' : 'are'} queued`
    ];
    const decision = (mapPath && todoPathRef)
      ? 'Decision: hold final approval until the validator run finishes.'
      : 'Decision: hold. Review setup is incomplete and needs fixing first.';

    printWorkflowBrief([
      'I checked the review setup.',
      readinessBits.join(', ') + '.',
      '',
      'This step prepares the validator. It does not mean the change has passed review yet.',
      'Confidence Gate: review must find loopholes, patch or name each one, and state residual risk before completion.',
      'Next I will run tests, walk each validate.md, and refresh the task projection/TODO view if durable state changed.',
      '',
      decision,
      'Run `atris review --verbose` for the full prompt and appendix.'
    ]);
  }
  if (showFull) {
    console.log('You are the Validator.');
    console.log('');
    console.log('Read these files:');
    console.log(`- ${validatorPath}`);
    if (testingGuideRef) console.log(`- ${testingGuideRef}`);
    if (personaRef) console.log(`- ${personaRef}`);
    if (mapPath) console.log(`- ${mapPath}`);
    if (todoPathRef) console.log(`- ${todoPathRef}`);
    console.log(`- ${journalPathRef}`);
    if (featuresReadmeRef) console.log(`- ${featuresReadmeRef}`);
    console.log('');
    if (!mapPath || mapIsPlaceholder) {
      console.log('Note: If `atris/MAP.md` is missing or placeholder, generate it from `atris/atris.md` before validating file:line references.');
      console.log('');
    }
    console.log('Workflow:');
    console.log('1) Run the project test suite (follow TESTING_GUIDE if present).');
    console.log('2) Execute any `atris/features/*/validate.md` scripts; if a step fails, fix + rerun.');
    console.log('3) Run the Confidence Gate before approving completion.');
    printConfidenceGate('   ');
    console.log('4) Confirm active task state is clean: no unresolved Backlog/In Progress/Blocked rows for the reviewed work.');
    console.log('   If durable task state changed, regenerate the readable view with `atris task render --out atris/TODO.md`.');
    console.log('   Do not hand-delete rendered completed history; use `atris task list --status done` for the ledger.');
    console.log('5) Log to atris/team/validator/journal/YYYY-MM-DD.md');
    console.log('   (Task, Result, Issues found, Learned)');
    console.log('6) If anything surprised you, append to atris/lessons.md.');
    console.log('');
    console.log('Done when: ✅ All good. Active task state clean. Ready for human testing.');
    console.log('');
  }

  if (showFull) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📎 APPENDIX (full context dumps):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    console.log('📋 VALIDATOR SPEC (full):');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(validatorSpec);
    console.log('');

    if (testingGuide) {
      console.log('🧪 TESTING GUIDE (full):');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(testingGuide);
      console.log('');
    }

    if (taskContexts) {
      console.log('📝 TODO.md (full):');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(taskContexts);
      console.log('');
    }
  }

  if (showFull) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💡 Next: Run "atris do" to fix any issues, then "atris review" again');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  }

  // Check execution mode
  if (executionMode === 'agent') {
    // Agent mode: execute via backend API
    if (!config.agent_id) {
      throw new Error('No agent selected. Run "atris agent" first.');
    }
    const ensured = await ensureValidCredentials(apiRequestJson);
    if (ensured.error === 'not_logged_in' || !ensured.credentials?.token) {
      throw new Error('Not logged in. Run "atris login" first.');
    }
    if (ensured.error) {
      throw new Error(`Authentication failed: ${ensured.detail || ensured.error}. Run "atris login" to re-authenticate.`);
    }
    const credentials = ensured.credentials;

    // Build system prompt
    let systemPrompt = '';
    if (validatorSpec) {
      systemPrompt += validatorSpec + '\n\n';
    }
    if (testingGuide) {
      systemPrompt += '## TESTING GUIDE\n' + testingGuide + '\n\n';
    }

    const personaFile = path.join(targetDir, 'PERSONA.md');
    if (fs.existsSync(personaFile)) {
      systemPrompt += '## PERSONA.md\n' + fs.readFileSync(personaFile, 'utf8') + '\n\n';
    }

    if (mapPath) {
      systemPrompt += `## MAP.md\nRead this file for file:line references: ${mapPath}\n\n`;
    }

    // Build user prompt with context
    let userPrompt = `You are the Validator. Auto-activated after "atris do" completes.\n\n`;
    userPrompt += `Validation Loop:\n`;
    userPrompt += `  1. Ultrathink (say "ultrathink", think 3 times)\n`;
    userPrompt += `  2. Check requirements → build → edge cases → errors → integration\n`;
    userPrompt += `  3. Run tests (unit, integration, linting, type checking)\n`;
    userPrompt += `  4. Run the Confidence Gate before approving completion\n`;
    userPrompt += confidenceGatePrompt('review') + `\n`;
    userPrompt += `  5. Detect Drift: Scan the Journal History below. Do you see the same friction 2x?\n`;
    userPrompt += `  6. If issues found: report → "atris do" fixes → "atris review" again\n`;
    userPrompt += `  7. Repeat until: "✅ All good. Ready for human testing."\n\n`;

    if (taskContexts) {
      userPrompt += `## TODO.md:\n${taskContexts}\n\n`;
    }

    if (journalHistory) {
      userPrompt += `## JOURNAL HISTORY (For Evolution/Drift Check):\n${journalHistory}\n\n`;
    }

    userPrompt += `Your job:\n`;
    userPrompt += `  • Verify everything works\n`;
    userPrompt += `  • Find all plausible loopholes; patch them or name residual risk\n`;
    userPrompt += `  • Test thoroughly (unless user says no)\n`;
    userPrompt += `  • Confirm active task state is clean — no unresolved Backlog/In Progress/Blocked rows for reviewed work.\n`;
    userPrompt += `    If durable task state changed, regenerate the readable view with \`atris task render --out atris/TODO.md\`.\n`;
    userPrompt += `    Do not hand-delete rendered completed history; if a task fails, move or mark it blocked with a note.\n`;
    userPrompt += `  • Log to atris/team/validator/journal/YYYY-MM-DD.md\n`;
    userPrompt += `    (Task, Result, Issues found, Learned)\n`;
    userPrompt += `  • If anything surprised you, append to atris/lessons.md\n`;
    userPrompt += `  • EVOLUTION: If you see drift in the logs, propose a tool upgrade.\n\n`;
    userPrompt += `The cycle: do → review → [issues] → do → review → ✅ Ready\n`;
    userPrompt += `Start validating now. Read files, run tests, verify implementation.`;

    console.log('');
    console.log('🤖 AGENT MODE: Executing via backend API...');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Execute via API
    try {
      await executeCodeExecution({
        prompt: userPrompt,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash'], // Validator needs to read, test, update docs
        permissionMode: 'default',
        maxTurns: 15,
        systemPrompt,
        workingDirectory: process.cwd(),
        agentId: config.agent_id,
        token: credentials.token,
        onMessage: (data) => {
          if (data.type === 'text' && data.content) {
            process.stdout.write(data.content);
          } else if (data.type === 'tool_use') {
            console.log(`\n🛠️  [${data.tool || data.tool_name}] ${JSON.stringify(data.input || data.tool_input || {}).substring(0, 100)}`);
          } else if (data.type === 'tool_result') {
            const result = data.result || data.content || '';
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const preview = resultStr.substring(0, 200);
            console.log(`\n✅ [Result] ${preview}${resultStr.length > 200 ? '...' : ''}`);
          } else if (data.type === 'error') {
            console.error(`\n❌ Error: ${data.error}`);
          } else if (data.type === 'result') {
            if (data.result) {
              console.log(`\n🎯 [Final] ${data.result}`);
            }
            if (data.duration_ms) {
              console.log(`⏱️  Duration: ${(data.duration_ms / 1000).toFixed(2)}s`);
            }
            if (data.cost_usd) {
              console.log(`💰 Cost: $${data.cost_usd.toFixed(4)}`);
            }
          }
        },
        onError: (error) => {
          console.error(`\n❌ Execution error: ${error.message}`);
        },
      });

      console.log('\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
    } catch (error) {
      console.error(`\n✗ Agent execution failed: ${error.message}`);
      throw error;
    }
  }
  // Prompt mode continues with existing output (already logged above)

  // Handoff prompt: suggest writing handoff if completions exist today
  if (fs.existsSync(logFile)) {
    const journalContent = fs.readFileSync(logFile, 'utf8');
    const hasCompletions = /## Completed ✅[\s\S]*?- \*\*C\d+:/.test(journalContent);
    const hasHandoff = /## Handoff[\s\S]*?\*\*Context:\*\*/.test(journalContent);

    if (hasCompletions && !hasHandoff) {
      if (showFull) {
        console.log('');
        console.log('┌─────────────────────────────────────────────────────────────┐');
        console.log('│ 📝 SESSION HANDOFF                                          │');
        console.log('├─────────────────────────────────────────────────────────────┤');
        console.log('│ You have completions today. Write a handoff for next session│');
        console.log('│                                                             │');
        console.log('│ Add to ## Handoff section in today\'s journal:               │');
        console.log('│   **Context:** [2 lines - what was accomplished]            │');
        console.log('│   **Blockers:** [any issues hit, or "none"]                 │');
        console.log('│   **Next:** [1 clear action for next session]               │');
        console.log('│   **Learned:** [key insight or pattern discovered]          │');
        console.log('└─────────────────────────────────────────────────────────────┘');
        console.log('');
      } else {
        console.log('');
        console.log('you have completions today. add a ## Handoff block to the journal (context / blockers / next / learned).');
        console.log('');
      }
    }
  }

  // Prompt for learnings (skip if stdin is not a TTY)
  if (!process.stdin.isTTY) return;

  console.log('');
  if (showFull) {
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ 💡 Any learnings?                                           │');
    console.log('│ (Enter insight, or press Enter to skip)                     │');
    console.log('└─────────────────────────────────────────────────────────────┘');
  } else {
    console.log('any learnings? (enter to skip)');
  }

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('> ', (answer) => {
      rl.close();

      if (answer && answer.trim()) {
        // Log to journal ## Notes section
        const { logFile } = getLogPath();
        if (fs.existsSync(logFile)) {
          let journalContent = fs.readFileSync(logFile, 'utf8');
          const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          const learning = `- ${timestamp} — ${answer.trim()}`;

          // Find or create ## Notes section
          if (journalContent.includes('## Notes')) {
            journalContent = journalContent.replace(/## Notes\n/, `## Notes\n${learning}\n`);
          } else {
            journalContent += `\n## Notes\n${learning}\n`;
          }

          fs.writeFileSync(logFile, journalContent);
          console.log('');
          console.log(`✓ Logged to journal: ${learning}`);
        }

        // Also log to structured learnings (if learnings module exists)
        try {
          const { addLearning } = require('../lib/learnings');
          const insight = answer.trim();
          // Auto-classify: starts with "don't" or "never" or "avoid" → pitfall, else pattern
          const type = /^(don't|never|avoid|watch out|careful)/i.test(insight) ? 'pitfall' : 'pattern';
          const key = insight.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 4).join('-');
          addLearning({ type, key, insight, confidence: 7, source: 'review', files: [] });
          console.log(`✓ Saved to learnings: [7/10] ${type}/${key}`);
        } catch {
          // learnings module not available — skip silently
        }
      }

      console.log('');
      resolve();
    });
  });
}

/**
 * Fast Agent SDK execution - for "atris go" command.
 * Direct execution without planning workflow, like "devin" or "cursor agent".
 */
async function executeAgentSDKFast(userInput) {
  const http = require('http');

  console.log(`⚡ Executing: ${userInput}`);
  console.log('');

  try {
    const postData = JSON.stringify({
      message: userInput,
      workspace_path: process.cwd(),
      model: 'claude-sonnet-4-6'
    });

    const options = {
      hostname: '127.0.0.1',
      port: 8000,
      path: '/api/agent-sdk/execute',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const response = await new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(parsed.detail || parsed.error || `HTTP ${res.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('Request timeout after 120s'));
      });
      req.write(postData);
      req.end();
    });

    if (response.error) {
      throw new Error(response.error);
    }

    // Display results in a clean format
    if (response.result && Array.isArray(response.result)) {
      for (const event of response.result) {
        if (event.type === 'assistant' && event.content) {
          for (const block of event.content) {
            if (block.type === 'text') {
              console.log(block.text);
            } else if (block.type === 'tool_use') {
              console.log(`\n⚙️  ${block.tool_name}`);
            }
          }
        } else if (event.type === 'result') {
          console.log(`\n✅ Done in ${event.duration_ms}ms`);
          if (event.cost_usd) {
            console.log(`💰 Cost: $${event.cost_usd.toFixed(4)}`);
          }
        }
      }
    }

  } catch (error) {
    console.error(`✗ Error: ${error.message}`);
    console.log('');
    console.log('💡 Make sure the AtrisOS backend is running on port 8000');
    console.log('   Start it with: cd /Users/keshavrao/arena/atrisos-backend/backend && python -m uvicorn main:app --reload --port 8000');
    process.exit(1);
  }
}

module.exports = {
  planAtris,
  doAtris,
  reviewAtris,
  executeAgentSDKFast
};
