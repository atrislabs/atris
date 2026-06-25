const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getLogPath, ensureLogDirectory, createLogFile } = require('../lib/journal');
// Inbox helpers live canonically (and CRLF-tolerant) in lib/file-ops; brainstorm
// used to carry byte-identical local copies that silently missed CRLF journals.
const {
  parseInboxItems,
  replaceInboxSection,
  addInboxItemToContent,
  getNextInboxId,
  addInboxIdea,
} = require('../lib/file-ops');
const { loadConfig } = require('../utils/config');
const { loadCredentials, ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { planAtris, doAtris, reviewAtris } = require('./workflow');

const pkg = require('../package.json');

async function brainstormAtris() {
  const args = process.argv.slice(3);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
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

  const targetDir = path.join(process.cwd(), 'atris');
  if (!fs.existsSync(targetDir)) {
    throw new Error('atris/ folder not found. Run "atris init" first.');
  }

  ensureLogDirectory();
  const { logFile, dateFormatted } = getLogPath();
  if (!fs.existsSync(logFile)) {
    createLogFile(logFile, dateFormatted);
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
  const ensured1 = await ensureValidCredentials(apiRequestJson);
  const credentials = ensured1.error ? null : ensured1.credentials;

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
          try {
            let latestContent = fs.readFileSync(logFile, 'utf8');
            latestContent = removeInboxItemFromContent(latestContent, selectedInboxItem.id);
            if (typeof latestContent !== 'string') {
              throw new Error('Archive operation produced invalid journal content.');
            }
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
            fs.writeFileSync(logFile, latestContent, 'utf8');
            console.log(`✓ Archived I${selectedInboxItem.id} from Inbox.`);
          } catch (error) {
            console.log(`Could not archive I${selectedInboxItem.id}: ${error.message}`);
          }
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

function removeInboxItemFromContent(content, id) {
  const items = parseInboxItems(content).filter((item) => item.id !== id);
  return replaceInboxSection(content, items);
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
  brainstormAtris
};
