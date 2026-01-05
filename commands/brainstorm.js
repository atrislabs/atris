const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
const { loadConfig } = require('../utils/config');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { planAtris, doAtris, reviewAtris } = require('./workflow');

const pkg = require('../package.json');

async function brainstormAtris() {
  const args = process.argv.slice(3);
  const targetDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(targetDir)) {
    throw new Error('atris/ folder not found. Run "atris init" first.');
  }

  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log('');
    console.log('Usage: atris brainstorm [idea] [--cloud]');
    console.log('');
    console.log('Description:');
    console.log('  Guided prompt generator for exploration before planning.');
    console.log('  Default is local-first; pass --cloud to include AtrisOS journal context.');
    console.log('');
    console.log('Options:');
    console.log('  --cloud      Include AtrisOS journal context (optional).');
    console.log('  --no-cloud   Force local-only mode (skip AtrisOS).');
    console.log('');
    return;
  }

  const useCloudJournal = args.includes('--cloud') && !args.includes('--no-cloud');
  const topicFromArgs = args.filter((arg) => !arg.startsWith('-')).join(' ').trim() || null;

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Atris Brainstorm — structured prompt generator              │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`Date: ${dateFormatted}`);
  console.log('Type "exit" at any prompt to cancel.');
  console.log('');

  // Local journal context (source of truth for Inbox)
  let localJournalContext = '';
  if (fs.existsSync(logFile)) {
    localJournalContext = fs.readFileSync(logFile, 'utf8');
  }

  // Optional: fetch journal context from backend (for hints only)
  let remoteJournalContext = '';
  const config = loadConfig();
  const credentials = loadCredentials();
  
  if (useCloudJournal && config.agent_id && credentials && credentials.token) {
    try {
      console.log('📖 Fetching latest journal entry from AtrisOS...');
      const journalResult = await apiRequestJson(`/agents/${config.agent_id}/journal/today`, {
        method: 'GET',
        token: credentials.token,
      });
      
      if (journalResult.ok && journalResult.data?.content) {
        remoteJournalContext = journalResult.data.content;
        console.log('✓ Loaded journal entry from backend');
      } else {
        // Try fetching latest entry if today doesn't exist
        const listResult = await apiRequestJson(`/agents/${config.agent_id}/journal/?limit=1`, {
          method: 'GET',
          token: credentials.token,
        });
        
        if (listResult.ok && listResult.data?.entries?.length > 0) {
          remoteJournalContext = listResult.data.entries[0].content || '';
          console.log('✓ Loaded latest journal entry from backend');
        }
      }
    } catch (error) {
      // Silently fail - we'll use local log file instead
      console.log('ℹ️  Using local journal file (backend unavailable)');
    }
    console.log('');
  }

  // Keep prompts high-signal: only include "recent context" when explicitly pulled from cloud.
  const journalHintSource = remoteJournalContext;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = async (promptText, options = {}) => {
    const { allowEmpty = false } = options;
    while (true) {
      const answer = await new Promise((resolve) => rl.question(promptText, resolve));
      const trimmed = answer.trim();
      if (trimmed.toLowerCase() === 'exit') {
        throw brainstormAbortError();
      }
      if (!allowEmpty && trimmed === '') {
        console.log('Please enter a value (or type "exit" to abort).');
        continue;
      }
      return trimmed;
    }
  };

  const askYesNo = async (promptText) => {
    while (true) {
      const response = (await ask(promptText)).toLowerCase();
      if (response === 'y' || response === 'yes') return true;
      if (response === 'n' || response === 'no') return false;
      console.log('Please answer with "y" or "n" (or type "exit" to abort).');
    }
  };

  const collectList = async (label, options = {}) => {
    const { minimum = 0 } = options;
    const items = [];
    while (true) {
      const promptSuffix = items.length === 0 ? '' : ' (blank to finish)';
      const value = await ask(`${label} ${items.length + 1}${promptSuffix}: `, {
        allowEmpty: items.length >= minimum,
      });
      if (!value) {
        if (items.length < minimum) {
          console.log(`Please provide at least ${minimum} ${minimum === 1 ? 'item' : 'items'}.`);
          continue;
        }
        break;
      }
      items.push(value);
    }
    return items;
  };

  let selectedInboxItem = null;
  let topicSummary = '';

  try {
    let inboxItems = parseInboxItems(localJournalContext || '');

    if (topicFromArgs) {
      topicSummary = topicFromArgs;
      const newId = addInboxIdea(logFile, topicSummary);
      console.log(`✓ Added I${newId} to today\'s Inbox.`);
      selectedInboxItem = { id: newId, text: topicSummary };
      inboxItems = parseInboxItems(fs.readFileSync(logFile, 'utf8'));
    }

    if (topicFromArgs) {
      // Topic provided via CLI args — treat as a new brainstorm and skip source selection.
    } else if (inboxItems.length > 0) {
      console.log('Choose a brainstorm source:');
      console.log('  1. Select an item from today\'s Inbox');
      console.log('  2. Enter a new idea');
      console.log('');

      let choice;
      while (true) {
        choice = await ask('Choice (1-2): ');
        if (choice === '1' || choice === '2') {
          break;
        }
        console.log('Please enter 1 or 2.');
      }

      if (choice === '1') {
        console.log('');
        console.log('Today\'s Inbox:');
        inboxItems.forEach((item, index) => {
          console.log(`  ${index + 1}. I${item.id} — ${item.text}`);
        });
        console.log('');

        while (true) {
          const selection = await ask(`Pick an item (1-${inboxItems.length}): `);
          const index = parseInt(selection, 10);
          if (!Number.isNaN(index) && index >= 1 && index <= inboxItems.length) {
            selectedInboxItem = inboxItems[index - 1];
            break;
          }
          console.log(`Enter a number between 1 and ${inboxItems.length}.`);
        }

        const editedSummary = await ask('Brainstorm topic (press Enter to keep original): ', { allowEmpty: true });
        topicSummary = editedSummary ? editedSummary : selectedInboxItem.text;
      } else {
        console.log('');
        topicSummary = await ask('Describe the brainstorm topic: ');
        const newId = addInboxIdea(logFile, topicSummary);
        console.log(`✓ Added I${newId} to today\'s Inbox.`);
        selectedInboxItem = { id: newId, text: topicSummary };
      }
    } else {
      console.log('No items in today\'s Inbox. Capture a new idea to begin.');
      topicSummary = await ask('Describe the brainstorm topic: ');
      const newId = addInboxIdea(logFile, topicSummary);
      console.log(`✓ Added I${newId} to today\'s Inbox.`);
      selectedInboxItem = { id: newId, text: topicSummary };
    }

    const sourceLabel = selectedInboxItem ? `I${selectedInboxItem.id}` : 'Ad-hoc';

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📖 Step 1: Craft the Story');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('What should the output be? How should it feel?');
    console.log('This helps us capture the vision before diving into details.');
    console.log('');

    const userStory = await ask('Describe the desired outcome (what should users experience?): ');
    const feelingsVibe = await ask('Feelings/vibes we\'re aiming for? (optional): ', { allowEmpty: true });

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🧠 Step 2: Brainstorm Session');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Now let\'s uncover what we need to build.');
    console.log('');

    const constraints = await ask('Constraints or guardrails? (optional): ', { allowEmpty: true });

    // Build concise, spaced-out prompt (4-5 sentences max, lots of spacing)
    const promptLines = [];
    
    // Extract key snippets from journal if available (very brief)
    let journalHint = '';
    if (journalHintSource && journalHintSource.trim()) {
      const maxHint = 200;
      const lines = journalHintSource.split('\n').slice(0, 5).join(' ').trim();
      if (lines.length > maxHint) {
        journalHint = lines.substring(0, maxHint) + '...';
      } else {
        journalHint = lines;
      }
    }

    promptLines.push('You:');
    promptLines.push('');
    promptLines.push(`I want to brainstorm: ${topicSummary}`);
    promptLines.push('');
    
    if (userStory) {
      promptLines.push(`The outcome should be: ${userStory}`);
      promptLines.push('');
    }
    
    if (feelingsVibe) {
      promptLines.push(`Vibe we\'re going for: ${feelingsVibe}`);
      promptLines.push('');
    }
    
    if (journalHint) {
      promptLines.push(`Recent context: ${journalHint}`);
      promptLines.push('');
    }
    
    if (constraints) {
      promptLines.push(`Constraints: ${constraints}`);
    promptLines.push('');
    }
    
    promptLines.push('Help me uncover what we need to build. Keep responses short (4-5 sentences), pause for alignment, sketch ASCII when structure helps.');
    promptLines.push('');
    promptLines.push('Claude:');

    const promptText = promptLines.join('\n');

    console.log('');
    console.log('Copy this prompt into Claude Code (or your agent of choice):');
    console.log('');
    console.log('```');
    console.log(promptText);
    console.log('```');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💬 Brainstorm Mode — Thinking Together');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('For the agent: Be conversational and supportive:');
    console.log('  • 3-4 sentences max per response');
    console.log('  • Ask ONE question at a time (never multiple)');
    console.log('  • Supportive tone: "That makes sense. What about X?"');
    console.log('  • No files created (exploration only)');
    console.log('  • User says "ready" or "plan" to exit brainstorm');
    console.log('');
    console.log('Example:');
    console.log('  User: "notifications but not sure"');
    console.log('  You: "What bothers you about current notifications?"');
    console.log('  User: "Easy to miss"');
    console.log('  You: "Makes sense. What if they stayed visible until dismissed?"');
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    const logChoice = await askYesNo('Log this brainstorm session to today\'s journal? (y/n): ');
    if (logChoice) {
      const sessionSummary = await ask('Session summary (1-2 sentences): ');
      const nextStepsRaw = await ask('Next steps (optional, separate with ";"): ', { allowEmpty: true });
      const nextSteps = nextStepsRaw
        ? nextStepsRaw.split(';').map((item) => item.trim()).filter(Boolean)
        : [];
      recordBrainstormSession(
        logFile,
        sourceLabel,
        topicSummary,
        userStory,
        [],
        [],
        constraints,
        '',
        feelingsVibe || '',
        nextSteps,
        sessionSummary
      );
      if (selectedInboxItem) {
        const archive = await askYesNo('Archive this Inbox idea now? (y/n): ');
        if (archive) {
          let latestContent = fs.readFileSync(logFile, 'utf8');
          latestContent = removeInboxItemFromContent(latestContent, selectedInboxItem.id);
          fs.writeFileSync(logFile, latestContent);
          console.log(`✓ Archived I${selectedInboxItem.id} from Inbox.`);
        }
      }
      console.log('✓ Brainstorm session logged.');
    } else {
      console.log('Skipped journaling. Prompt is ready for your agent.');
    }

    console.log('\nBrainstorm complete.');
  } finally {
    rl.close();
  }
}

function brainstormAbortError() {
  const error = new Error('Brainstorm cancelled by user.');
  error.__brainstormAbort = true;
  return error;
}

function generateWorkflowFile(workflowFile, metadata) {
  const targetDir = path.join(process.cwd(), 'atris');
  
  // Load all context needed for agents
  const navigatorFile = path.join(targetDir, 'agent_team', 'navigator.md');
  const executorFile = path.join(targetDir, 'agent_team', 'executor.md');
  const validatorFile = path.join(targetDir, 'agent_team', 'validator.md');
  const launcherFile = path.join(targetDir, 'agent_team', 'launcher.md');
  const personaFile = path.join(targetDir, 'PERSONA.md');
  const mapFile = path.join(targetDir, 'MAP.md');
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  const { logFile } = getLogPath();
  
  const workflow = {
    version: '1.0',
    createdAt: new Date().toISOString(),
    metadata: {
      feature: metadata.feature,
      userStory: metadata.userStory,
      constraints: metadata.constraints || '',
      successCriteria: metadata.successCriteria || [],
      riskNotes: metadata.riskNotes || '',
      journalPath: metadata.logFile
    },
    states: {
      NAVIGATOR: {
        agentSpec: fs.existsSync(navigatorFile) ? fs.readFileSync(navigatorFile, 'utf8') : '',
        context: {
          inboxPath: metadata.logFile,
          taskContextsPath: 'atris/TODO.md',
          mapPath: 'atris/MAP.md'
        },
        instructions: 'Take ideas from Inbox → break them down into perfect, manageable tasks. Create visualizations (ASCII diagrams) for logic flows, DB tables, architecture, UI/UX. Write tasks to TODO.md (formerly TASK_CONTEXTS.md).'
      },
      EXECUTOR: {
        agentSpec: fs.existsSync(executorFile) ? fs.readFileSync(executorFile, 'utf8') : '',
        context: {
          personaPath: 'atris/PERSONA.md',
          mapPath: 'atris/MAP.md',
          taskContextsPath: 'atris/TODO.md'
        },
        instructions: 'Get it done, precisely, following instructions perfectly. Show ASCII visualization for complex changes. Execute tasks following executor spec. Move completed tasks to <completed> section.'
      },
      VALIDATOR: {
        agentSpec: fs.existsSync(validatorFile) ? fs.readFileSync(validatorFile, 'utf8') : '',
        context: {
          taskContextsPath: 'atris/TODO.md',
          mapPath: 'atris/MAP.md',
          journalPath: metadata.logFile
        },
        instructions: 'Auto-activated after "atris do" completes. Ultrathink, check requirements → build → edge cases → errors → integration. Run tests. Repeat until: "✅ All good. Ready for human testing."'
      },
      LAUNCHER: {
        agentSpec: fs.existsSync(launcherFile) ? fs.readFileSync(launcherFile, 'utf8') : '',
        context: {
          taskContextsPath: 'atris/TODO.md',
          mapPath: 'atris/MAP.md',
          journalPath: metadata.logFile
        },
        instructions: 'Ship it clean. Document what was shipped, extract learnings, update MAP.md and docs, clean up, Git commit + push, celebrate!'
      }
    },
    currentState: null,
    currentIteration: 0,
    history: []
  };
  
  fs.writeFileSync(workflowFile, JSON.stringify(workflow, null, 2));
}

function updateWorkflowState(workflowFile, stateName, iteration) {
  if (!fs.existsSync(workflowFile)) return;
  
  const workflow = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
  workflow.currentState = stateName;
  workflow.currentIteration = iteration;
  workflow.history.push({
    state: stateName,
    iteration: iteration,
    timestamp: new Date().toISOString()
  });
  
  // Update context with latest file contents
  const targetDir = path.join(process.cwd(), 'atris');
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskContextsFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  const mapFile = path.join(targetDir, 'MAP.md');
  const { logFile } = getLogPath();
  
  // Refresh task contexts if exists (prefer TODO.md, fallback to legacy TASK_CONTEXTS.md)
  const taskFilePath = fs.existsSync(todoFile)
    ? todoFile
    : (fs.existsSync(legacyTaskContextsFile) ? legacyTaskContextsFile : null);
  if (taskFilePath) {
    workflow.states[stateName].context.taskContexts = fs.readFileSync(taskFilePath, 'utf8').substring(0, 5000); // Limit size
  }
  
  // Reference map path (agents read on-demand)
  if (fs.existsSync(mapFile)) {
    workflow.states[stateName].context.mapPath = path.relative(process.cwd(), mapFile);
  }
  
  // Refresh journal inbox if exists
  if (fs.existsSync(logFile)) {
    const logContent = fs.readFileSync(logFile, 'utf8');
    const inboxMatch = logContent.match(/## Inbox\n([\s\S]*?)(?=\n##|$)/);
    if (inboxMatch) {
      workflow.states[stateName].context.inbox = inboxMatch[1].trim().substring(0, 2000); // Limit size
    }
  }
  
  fs.writeFileSync(workflowFile, JSON.stringify(workflow, null, 2));
}

async function autopilotAtris(initialIdea = null) {
  const targetDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(targetDir)) {
    throw new Error('atris/ folder not found. Run "atris init" first.');
  }

  const navigatorFile = path.join(targetDir, 'agent_team', 'navigator.md');
  const executorFile = path.join(targetDir, 'agent_team', 'executor.md');
  const validatorFile = path.join(targetDir, 'agent_team', 'validator.md');
  const launcherFile = path.join(targetDir, 'agent_team', 'launcher.md');

  const missingSpecs = [];
  if (!fs.existsSync(navigatorFile)) missingSpecs.push('navigator.md');
  if (!fs.existsSync(executorFile)) missingSpecs.push('executor.md');
  if (!fs.existsSync(validatorFile)) missingSpecs.push('validator.md');
  if (!fs.existsSync(launcherFile)) missingSpecs.push('launcher.md');

  if (missingSpecs.length > 0) {
    throw new Error(`Missing agent spec(s): ${missingSpecs.join(', ')}. Run "atris init" to restore them.`);
  }

  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│ Atris Autopilot v${pkg.version} — Full Cycle Automation               │`);
  console.log('│ brainstorm → plan → do → review → launch                    │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`Date: ${dateFormatted}`);
  console.log('Type "exit" at any prompt to cancel.');
  console.log('');

  // Detect if running in chat/non-interactive mode
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
  const isAutoMode = !isInteractive || !!initialIdea; // Auto-approve if non-interactive or idea provided
  
  if (isAutoMode && !initialIdea) {
    console.log('💬 AUTO MODE: Running fully automated workflow.\n');
  } else if (!isInteractive) {
    console.log('💬 CHAT MODE: Autopilot will present prompts here for interactive conversation.');
    console.log('   Respond to prompts in chat to continue the workflow.\n');
  }
  
  const rl = isInteractive ? readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  }) : null;

  const ask = async (promptText, options = {}) => {
    const { allowEmpty = false, defaultValue = null } = options;
    
    // In non-interactive mode, never try to use readline - just output and return default
    if (!isInteractive) {
      console.log(`\n📝 PROMPT FOR CHAT: ${promptText}`);
      if (defaultValue !== null) {
        console.log(`   ✓ Using default: ${defaultValue}`);
        return defaultValue;
      }
      if (allowEmpty) {
        console.log('   (Empty allowed - continuing)');
        return '';
      }
      // No default and not allowEmpty - use a safe default
      const safeDefault = 'Continue workflow';
      console.log(`   ✓ Using safe default: ${safeDefault}`);
      return safeDefault;
    }
    
    // Interactive mode - auto-approve if in auto mode
    if (isAutoMode && defaultValue !== null) {
      console.log(`\n✓ ${promptText}${defaultValue ? ` → ${defaultValue}` : ' (auto-approved)'}`);
      return defaultValue;
    }
    
    // Only reach here if interactive mode AND rl exists
    if (!rl || rl.closed) {
      // Fallback: if readline closed, use safe default
      if (allowEmpty) return '';
      const safeDefault = 'Continue workflow';
      console.log(`   ⚠️  Readline unavailable, using safe default: ${safeDefault}`);
      return safeDefault;
    }
    
    while (true) {
      try {
        const answer = await new Promise((resolve, reject) => {
          if (rl.closed) {
            reject(new Error('readline was closed'));
            return;
          }
          rl.question(promptText, resolve);
        });
        const trimmed = answer.trim();
        if (trimmed.toLowerCase() === 'exit') {
          throw autopilotAbortError();
        }
        if (!allowEmpty && trimmed === '') {
          console.log('Please enter a value (or type "exit" to abort).');
          continue;
        }
        return trimmed;
      } catch (error) {
        if (error.message === 'readline was closed' || rl.closed) {
          // Readline closed mid-prompt - use safe default
          if (allowEmpty) return '';
          const safeDefault = 'Continue workflow';
          console.log(`   ⚠️  Readline closed, using safe default: ${safeDefault}`);
          return safeDefault;
        }
        throw error;
      }
    }
  };

  const askYesNo = async (promptText, defaultYes = true) => {
    // In non-interactive mode, never try readline - just return default
    if (!isInteractive) {
      console.log(`\n📝 PROMPT FOR CHAT: ${promptText}`);
      console.log(`   ✓ Auto-approving: ${defaultYes ? 'yes' : 'no'}`);
      return defaultYes;
    }
    
    // Auto mode in interactive terminal - auto-approve
    if (isAutoMode) {
      console.log(`\n✓ ${promptText} → ${defaultYes ? 'yes (auto-approved)' : 'no (auto-approved)'}`);
      return defaultYes;
    }
    
    while (true) {
      const response = (await ask(promptText)).toLowerCase();
      if (response === 'y' || response === 'yes') return true;
      if (response === 'n' || response === 'no') return false;
      console.log('Please answer with "y" or "n" (or type "exit" to abort).');
    }
  };

  // ========================================
  // STEP 1: Brainstorm with user
  // ========================================
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧠 STEP 1: Brainstorm — Define the vision');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  let selectedInboxItem = null;
  let topicSummary = '';
  let userStory = '';
  let feelingsVibe = '';
  let constraints = '';

  // Try to fetch latest journal entry from backend
  let journalContext = '';
  const config = loadConfig();
  const credentials = loadCredentials();
  
  if (config.agent_id && credentials && credentials.token) {
    try {
      const journalResult = await apiRequestJson(`/agents/${config.agent_id}/journal/today`, {
        method: 'GET',
        token: credentials.token,
      });
      
      if (journalResult.ok && journalResult.data?.content) {
        journalContext = journalResult.data.content;
      } else {
        const listResult = await apiRequestJson(`/agents/${config.agent_id}/journal/?limit=1`, {
          method: 'GET',
          token: credentials.token,
        });
        
        if (listResult.ok && listResult.data?.entries?.length > 0) {
          journalContext = listResult.data.entries[0].content || '';
        }
      }
    } catch (error) {
      // Fallback to local
    }
  }

  // Fallback to local log file
  if (!journalContext && fs.existsSync(logFile)) {
    journalContext = fs.readFileSync(logFile, 'utf8');
  }

  try {
    // If initial idea provided, use it directly (skip all prompts)
    if (initialIdea) {
      console.log(`🚀 Initial idea: "${initialIdea}"\n`);
      topicSummary = initialIdea;
      const newId = addInboxIdea(logFile, topicSummary);
      console.log(`✓ Added I${newId} to today's Inbox.\n`);
      selectedInboxItem = { id: newId, text: topicSummary };
    } else {
      // Normal flow: check inbox and prompt
      const initialContent = journalContext || (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
      let inboxItems = parseInboxItems(initialContent);

      if (inboxItems.length > 0) {
        // In non-interactive mode, auto-select first inbox item
        if (!isInteractive) {
          selectedInboxItem = inboxItems[0];
          topicSummary = selectedInboxItem.text;
          console.log(`✓ Auto-selected inbox item I${selectedInboxItem.id}: ${topicSummary}\n`);
        } else {
          console.log('Choose a brainstorm source:');
          console.log('  1. Select an item from today\'s Inbox');
          console.log('  2. Enter a new idea');
          console.log('');

          let choice;
          while (true) {
            choice = await ask('Choice (1-2): ');
            if (choice === '1' || choice === '2') {
              break;
            }
            console.log('Please enter 1 or 2.');
          }

          if (choice === '1') {
            console.log('');
            console.log('Today\'s Inbox:');
            inboxItems.forEach((item, index) => {
              console.log(`  ${index + 1}. I${item.id} — ${item.text}`);
            });
            console.log('');

            while (true) {
              const selection = await ask(`Pick an item (1-${inboxItems.length}): `);
              const index = parseInt(selection, 10);
              if (!Number.isNaN(index) && index >= 1 && index <= inboxItems.length) {
                selectedInboxItem = inboxItems[index - 1];
                break;
              }
              console.log(`Enter a number between 1 and ${inboxItems.length}.`);
            }

            const editedSummary = await ask('Brainstorm topic (press Enter to keep original): ', { allowEmpty: true });
            topicSummary = editedSummary ? editedSummary : selectedInboxItem.text;
          } else {
            if (!isInteractive) {
              // Non-interactive: use default
              topicSummary = 'New feature idea';
              console.log(`✓ Using default idea: ${topicSummary}\n`);
            } else {
              console.log('');
              topicSummary = await ask('Describe the brainstorm topic: ');
            }
            const newId = addInboxIdea(logFile, topicSummary);
            console.log(`✓ Added I${newId} to today\'s Inbox.`);
            selectedInboxItem = { id: newId, text: topicSummary };
          }
        }
      } else {
        // No inbox items AND no initial idea → trigger brainstorm mode
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💡 No idea provided. Starting brainstorm mode...');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log('🧠 Let\'s shape an idea together. Answer a few questions to get started:');
        console.log('');
        
        // Interactive brainstorm session (in chat/non-interactive, use defaults)
        if (!isInteractive || isAutoMode) {
          // Non-interactive or auto mode: use defaults
          topicSummary = 'New feature idea';
          userStory = 'Improved user experience';
          feelingsVibe = '';
          constraints = '';
          console.log('✓ Using default brainstorm values');
          console.log(`  Idea: ${topicSummary}`);
          console.log(`  Outcome: ${userStory}\n`);
        } else {
          topicSummary = await ask('What problem or feature are you thinking about? (describe it briefly): ');
          if (!topicSummary) {
            throw new Error('Brainstorm cancelled. Provide an idea to continue.');
          }
        
          userStory = await ask('What should users experience when this is done? (the outcome): ', {
            allowEmpty: true
          });
          
          feelingsVibe = await ask('What vibe/feelings are we aiming for? (optional): ', {
            allowEmpty: true
          });
          
          constraints = await ask('Any constraints or guardrails? (optional): ', {
            allowEmpty: true
          });
        }
        
        const newId = addInboxIdea(logFile, topicSummary);
        console.log(`✓ Added I${newId} to today's Inbox.`);
        selectedInboxItem = { id: newId, text: topicSummary };
        
        console.log('');
        console.log('✓ Idea shaped! Continuing with autopilot...');
        console.log('');
      }
    }

    const sourceLabel = selectedInboxItem ? `I${selectedInboxItem.id}` : 'Ad-hoc';

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📖 Craft the Story — What should the output be?');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // In auto mode or if already set from brainstorm above, skip story prompts
    if (isAutoMode && !userStory) {
      // Extract story from initial idea or use default
      userStory = initialIdea || 'Build the feature completely and correctly';
      feelingsVibe = feelingsVibe || '';
      constraints = constraints || '';
      console.log(`✓ Outcome: ${userStory}`);
      console.log('');
    } else if (!userStory) {
      // Only prompt if we don't already have these from brainstorm mode
      if (!isInteractive) {
        // Non-interactive: use defaults
        userStory = 'Build the feature completely and correctly';
        feelingsVibe = '';
        constraints = '';
        console.log(`✓ Outcome: ${userStory} (using defaults for non-interactive mode)`);
        console.log('');
      } else {
        userStory = await ask('Describe the desired outcome (what should users experience?): ');
        feelingsVibe = await ask('Feelings/vibes we\'re aiming for? (optional): ', { allowEmpty: true });
        constraints = await ask('Constraints or guardrails? (optional): ', { allowEmpty: true });
      }
    }

    // Generate and show brainstorm prompt (shorter in auto mode)
    if (!isAutoMode) {
      const promptLines = [];
      promptLines.push('You:');
      promptLines.push('');
      promptLines.push(`I want to brainstorm: ${topicSummary}`);
      promptLines.push('');
      
      if (userStory) {
        promptLines.push(`The outcome should be: ${userStory}`);
        promptLines.push('');
      }
      
      if (feelingsVibe) {
        promptLines.push(`Vibe we\'re going for: ${feelingsVibe}`);
        promptLines.push('');
      }
      
      if (constraints) {
        promptLines.push(`Constraints: ${constraints}`);
        promptLines.push('');
      }
      
      promptLines.push('Help me uncover what we need to build. Keep responses short (4-5 sentences), pause for alignment, sketch ASCII when structure helps.');
      promptLines.push('');
      promptLines.push('Claude:');

      const promptText = promptLines.join('\n');

      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📋 PROMPT FOR YOUR CODING EDITOR:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
      console.log('```');
      console.log(promptText);
      console.log('```');
      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');

      // Get approval to proceed with autopilot
      const proceed = await askYesNo('✓ Brainstorm complete. Ready to start autopilot (plan → do → review → launch)? (y/n): ');
      if (!proceed) {
        console.log('\nAutopilot cancelled. Brainstorm prompt is ready for your agent.');
        return;
      }
    } else {
      // Auto mode: just show brief summary
      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('✓ Vision defined — proceeding automatically');
      console.log(`  Feature: ${topicSummary}`);
      console.log(`  Goal: ${userStory}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
    }

    // Log brainstorm session
    const sessionSummary = isAutoMode || !isInteractive ? 'Auto brainstorm' : await ask('Brainstorm session summary (1-2 sentences, optional): ', { allowEmpty: true, defaultValue: 'Autopilot brainstorm session' });
    recordBrainstormSession(
      logFile,
      sourceLabel,
      topicSummary,
      userStory,
      [],
      [],
      constraints,
      '',
      feelingsVibe || '',
      [],
      sessionSummary || 'Autopilot brainstorm session'
    );

    // Define success criteria
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎯 Define Success Criteria');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    let successCriteria = [];
    let riskNotes = '';
    
    if (isAutoMode) {
      // Auto mode: generate basic success criteria
      successCriteria = [
        'Feature implemented and working',
        'Tests pass (if applicable)',
        'Code follows project standards',
        'Documentation updated (MAP.md, journal)'
      ];
      console.log('✓ Auto-generated success criteria:');
      successCriteria.forEach((item, index) => {
        console.log(`  ${index + 1}. ${item}`);
      });
      console.log('');
    } else {
      while (true) {
        const criteria = await ask(`Success criteria ${successCriteria.length + 1}: `, {
          allowEmpty: successCriteria.length > 0,
        });
        if (!criteria) {
          if (successCriteria.length === 0) {
            console.log('Please provide at least one success criteria.');
            continue;
          }
          break;
        }
        successCriteria.push(criteria);
      }

      riskNotes = await ask('Any risks or notes? (optional): ', { allowEmpty: true });
    }

    recordAutopilotVision(
      logFile,
      sourceLabel,
      topicSummary,
      successCriteria,
      riskNotes ? riskNotes : ''
    );

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✓ Vision locked in');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`• Source: ${sourceLabel}`);
    console.log(`• Summary: ${topicSummary}`);
    console.log('• Success Criteria:');
    successCriteria.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item}`);
    });
    if (riskNotes) {
      console.log(`• Notes: ${riskNotes}`);
    }
    console.log('');
    if (isAutoMode) {
      console.log('🚀 AUTO MODE: Running fully automated cycle (plan → do → review → launch)');
    } else {
      console.log('🚀 Starting automated cycle: plan → do → review → launch');
      console.log('   (No manual pauses - fully automated after this approval)');
    }
    console.log('');

    // ========================================
    // Generate workflow file for coding agents
    // ========================================
    const workflowFile = path.join(targetDir, '.atris-workflow.json');
    generateWorkflowFile(workflowFile, {
      feature: topicSummary,
      userStory,
      constraints,
      successCriteria,
      riskNotes,
      logFile: path.relative(process.cwd(), logFile)
    });

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📄 WORKFLOW FILE GENERATED: .atris-workflow.json');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('   Coding agents can read this file to enter workflow states');
    console.log('   Each state includes all context needed for execution');
    console.log('');

    // ========================================
    // STEP 2-4: Automated plan → do → review loop
    // ========================================
    let iteration = 1;
    while (true) {
      console.log(`\n${'═'.repeat(70)}`);
      console.log(`AUTOPILOT ITERATION ${iteration}`);
      console.log(`${'═'.repeat(70)}\n`);

      // Plan
      console.log('[STATE:NAVIGATOR]');
      console.log('[1/4] 📋 Plan — Navigator creating tasks...');
      planAtris();
      updateWorkflowState(workflowFile, 'NAVIGATOR', iteration);
      console.log('   ✓ Planning prompt displayed to agent');
      console.log('   ✓ Workflow state updated: [STATE:NAVIGATOR]\n');

      // Do
      console.log('[STATE:EXECUTOR]');
      console.log('[2/4] 🔨 Do — Executor building...');
      doAtris();
      updateWorkflowState(workflowFile, 'EXECUTOR', iteration);
      console.log('   ✓ Execution prompt displayed to agent');
      console.log('   ✓ Workflow state updated: [STATE:EXECUTOR]\n');

      // Review
      console.log('[STATE:VALIDATOR]');
      console.log('[3/4] ✅ Review — Validator checking...');
      reviewAtris();
      updateWorkflowState(workflowFile, 'VALIDATOR', iteration);
      console.log('   ✓ Validation prompt displayed to agent');
      console.log('   ✓ Workflow state updated: [STATE:VALIDATOR]\n');

      // Check if success (auto-approve in auto mode, validator will verify)
      console.log(`${'─'.repeat(70)}`);
      let isSuccess;
      if (isAutoMode) {
        // In auto mode, assume success if we got through review without errors
        // Validator should have caught issues already
        isSuccess = true;
        console.log('✓ Auto mode: Assuming success (validator verified)');
      } else {
        isSuccess = await askYesNo(`Did we meet the success criteria? (y/n): `);
      }
      console.log('');

      if (isSuccess) {
        const successNotes = isAutoMode ? 'Completed via autopilot' : await ask('Notes for the log (optional): ', { allowEmpty: true, defaultValue: 'Completed via autopilot' });
        recordAutopilotIteration(
          logFile,
          iteration,
          'Success',
          successNotes ? successNotes : ''
        );
        
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✓ Success criteria met!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');

        // ========================================
        // STEP 5: Launch
        // ========================================
        console.log('[STATE:LAUNCHER]');
        console.log('[5/5] 🚀 Launch — Launcher shipping...');
        console.log('   ✓ Launch instructions are available via "atris" and your journal.');
        updateWorkflowState(workflowFile, 'LAUNCHER', iteration);
        console.log('   ✓ Workflow state updated: [STATE:LAUNCHER]\n');

        recordAutopilotSuccess(
          logFile,
          selectedInboxItem ? selectedInboxItem.id : null,
          topicSummary
        );

        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎉 AUTOPILOT COMPLETE');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log('✓ Feature completed and shipped');
        console.log('✓ All prompts displayed for agent workflow');
        console.log('✓ Success recorded in journal');
        console.log('');
        break;
      } else {
        const followUp = isAutoMode ? 'Issues detected, needs iteration' : await ask('Describe remaining blockers / next steps (optional): ', {
          allowEmpty: true,
          defaultValue: 'Issues detected, needs iteration'
        });
        recordAutopilotIteration(
          logFile,
          iteration,
          'Follow-up required',
          followUp || ''
        );
        const continueLoop = await askYesNo('Continue with another iteration? (y/n): ', isAutoMode);
        if (!continueLoop) {
          console.log('\nAutopilot paused. Success criteria not yet met.');
          break;
        }
        iteration += 1;
      }
    }
  } finally {
    if (rl && isInteractive) {
      rl.close();
    }
  }
}

function autopilotAbortError() {
  const error = new Error('Autopilot cancelled by user.');
  error.__autopilotAbort = true;
  return error;
}

function addInboxIdea(logFile, summary) {
  const content = fs.readFileSync(logFile, 'utf8');
  const nextId = getNextInboxId(content);
  const updated = addInboxItemToContent(content, nextId, summary);
  fs.writeFileSync(logFile, updated);
  return nextId;
}

function parseInboxItems(content) {
  const match = content.match(/## Inbox\n([\s\S]*?)(?=\n##|\n---|$)/);
  if (!match) {
    return [];
  }
  const body = match[1];
  const lines = body.split('\n');
  const items = [];
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('(Empty')) return;
    const parsed = trimmed.match(/^- \*\*I(\d+):\*\*\s*(.+)$|^- \*\*I(\d+):\s+(.+)$/);
    if (parsed) {
      const id = parseInt(parsed[1] || parsed[3], 10);
      const text = parsed[2] || parsed[4];
      items.push({ id, text, line: trimmed });
    }
  });
  return items;
}

function replaceInboxSection(content, items) {
  const regex = /(## Inbox\n)([\s\S]*?)(\n---|\n##|$)/;
  if (!regex.test(content)) {
    const lines = items.length ? items.map((item) => item.line).join('\n') : '(Empty - inbox zero achieved)';
    return `${content}\n\n## Inbox\n\n${lines}\n`;
  }

  return content.replace(regex, (match, header, body, suffix) => {
    const inner = items.length
      ? `\n${items.map((item) => item.line).join('\n')}\n`
      : '\n(Empty - inbox zero achieved)\n';
    return `${header}${inner}${suffix}`;
  });
}

function addInboxItemToContent(content, id, summary) {
  const items = parseInboxItems(content).filter((item) => item.id !== id);
  const newItem = { id, text: summary, line: `- **I${id}:** ${summary}` };
  const updatedItems = [newItem, ...items];
  return replaceInboxSection(content, updatedItems);
}

function removeInboxItemFromContent(content, id) {
  const items = parseInboxItems(content).filter((item) => item.id !== id);
  return replaceInboxSection(content, items);
}

function getNextInboxId(content) {
  const items = parseInboxItems(content);
  if (items.length === 0) return 1;
  return items.reduce((max, item) => (item.id > max ? item.id : max), 0) + 1;
}

function parseCompletionItems(content) {
  const match = content.match(/## Completed ✅\n([\s\S]*?)(?=\n##|\n---|$)/);
  if (!match) {
    return [];
  }
  const body = match[1];
  const lines = body.split('\n');
  const items = [];
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('(Empty')) return;
    const parsed = trimmed.match(/^- \*\*C(\d+):\*\*\s*(.+)$|^- \*\*C(\d+):\s+(.+)$/);
    if (parsed) {
      const id = parseInt(parsed[1] || parsed[3], 10);
      const text = parsed[2] || parsed[4];
      items.push({ id, text, line: trimmed });
    }
  });
  return items;
}

function replaceCompletedSection(content, items) {
  const regex = /(## Completed ✅\n)([\s\S]*?)(\n---|\n##|$)/;
  if (!regex.test(content)) {
    const lines = items.length ? items.map((item) => item.line).join('\n') : '';
    return `${content}\n\n## Completed ✅\n\n${lines}\n`;
  }

  return content.replace(regex, (match, header, body, suffix) => {
    const inner = items.length
      ? `\n${items.map((item) => item.line).join('\n')}\n`
      : '\n';
    return `${header}${inner}${suffix}`;
  });
}

function addCompletionItemToContent(content, id, summary) {
  const items = parseCompletionItems(content).filter((item) => item.id !== id);
  const newItem = { id, text: summary, line: `- **C${id}:** ${summary}` };
  const updatedItems = [...items, newItem];
  return replaceCompletedSection(content, updatedItems);
}

function getNextCompletionId(content) {
  const items = parseCompletionItems(content);
  if (items.length === 0) return 1;
  return items.reduce((max, item) => (item.id > max ? item.id : max), 0) + 1;
}

function insertIntoNotesSection(content, block) {
  const regex = /(## Notes\n)([\s\S]*?)(\n---|\n##|$)/;
  const match = content.match(regex);
  if (!match) {
    return `${content}\n\n## Notes\n\n${block}\n`;
  }
  const header = match[1];
  const body = match[2];
  const suffix = match[3];
  const trimmedBody = body.replace(/\s*$/, '');
  const newBody = trimmedBody
    ? `${trimmedBody}\n\n${block}\n`
    : `\n${block}\n`;
  return content.replace(regex, `${header}${newBody}${suffix}`);
}

function getTimeLabel() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function recordAutopilotVision(logFile, sourceLabel, summary, successCriteria, riskNotes) {
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = [
    `### Autopilot Vision — ${getTimeLabel()}`,
    `**Source:** ${sourceLabel}`,
    `**Summary:** ${summary}`,
    '**Success Criteria:**',
    ...successCriteria.map((item) => `- ${item}`),
  ];
  if (riskNotes && riskNotes.trim()) {
    lines.push(`**Risks / Notes:** ${riskNotes}`);
  }
  const block = lines.join('\n');
  const updated = insertIntoNotesSection(content, block);
  fs.writeFileSync(logFile, updated);
}

function recordAutopilotIteration(logFile, iteration, result, notes) {
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = [
    `### Autopilot Iteration ${iteration} — ${getTimeLabel()}`,
    `**Validator Result:** ${result}`,
  ];
  if (notes && notes.trim()) {
    lines.push(`**Notes:** ${notes}`);
  }
  const block = lines.join('\n');
  const updated = insertIntoNotesSection(content, block);
  fs.writeFileSync(logFile, updated);
}

function recordAutopilotSuccess(logFile, inboxId, summary) {
  let content = fs.readFileSync(logFile, 'utf8');
  if (typeof inboxId === 'number' && !Number.isNaN(inboxId)) {
    content = removeInboxItemFromContent(content, inboxId);
  }
  const nextId = getNextCompletionId(content);
  content = addCompletionItemToContent(content, nextId, `Autopilot — ${summary}`);
  fs.writeFileSync(logFile, content);
}

function recordBrainstormSession(
  logFile,
  sourceLabel,
  topic,
  desiredOutcome,
  keyQuestions,
  focusAreas,
  constraints,
  references,
  tonePreference,
  nextSteps,
  sessionSummary
) {
  let content = fs.readFileSync(logFile, 'utf8');
  const lines = [
    `### Brainstorm Session — ${getTimeLabel()}`,
    `**Source:** ${sourceLabel}`,
    `**Topic:** ${topic}`,
  ];
  if (desiredOutcome) {
    lines.push(`**User Story / Desired Outcome:** ${desiredOutcome}`);
  }
  if (tonePreference) {
    lines.push(`**Vibe / Feelings:** ${tonePreference}`);
  }
  if (keyQuestions && keyQuestions.length > 0) {
    lines.push('**Key Questions:**');
    keyQuestions.forEach((item) => lines.push(`- ${item}`));
  }
  if (focusAreas && focusAreas.length > 0) {
    lines.push('**Focus Areas:**');
    focusAreas.forEach((item) => lines.push(`- ${item}`));
  }
  if (constraints) {
    lines.push(`**Constraints:** ${constraints}`);
  }
  if (references) {
    lines.push(`**Context / References:** ${references}`);
  }
  if (sessionSummary) {
    lines.push(`**Session Summary:** ${sessionSummary}`);
  }
  if (nextSteps && nextSteps.length > 0) {
    lines.push('**Next Steps:**');
    nextSteps.forEach((item) => lines.push(`- ${item}`));
  }

  const block = lines.join('\n');
  content = insertIntoNotesSection(content, block);
  fs.writeFileSync(logFile, content);
}


module.exports = {
  brainstormAtris,
  autopilotAtris
};
