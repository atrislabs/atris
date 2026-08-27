'use strict';

const { argsWantHelp, wantsJson } = require('../lib/noninteractive');
const {
  buildFirstMinute,
  folderName,
  freshMinuteJson,
  isFreshWorkspace,
  listUserVisibleWork,
} = require('../lib/first-minute');
const { loadContext } = require('../lib/state-detection');
const {
  claimRoadmapItem,
  nextCards,
  markDreamCardConsumed,
  parkNextCard,
  recordDecision,
  seedInboxFromMove,
} = require('../lib/next-moves');

function showHelp(log = console.log) {
  log('Usage: atris next [--json]');
  return 0;
}

function spokenWin(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function minuteText(screen) {
  const win = spokenWin(screen && screen.text);
  const next = String(screen && screen.nextCommand || '').trim();
  if (!next) return win || 'nothing is waiting.';
  return `${win}\n\nnext: ${next}`;
}

function minuteJson(screen, extra = {}) {
  const reason = spokenWin(screen && screen.text).replace(/\.$/, '');
  const next = String((screen && screen.nextCommand) || extra.next_action || '').trim();
  const fresh = extra.fresh === true;
  return {
    schema: 'atris.one_lap.v1',
    ok: Boolean(next) && !fresh,
    status: fresh ? 'stuck' : (next ? 'ok' : 'stuck'),
    reason,
    next_action: next,
  };
}

function printMinute(screen, { asJson = false, log = console.log, fresh = false } = {}) {
  if (asJson) {
    log(JSON.stringify(minuteJson(screen, { fresh }), null, 2));
    return 0;
  }
  log('');
  log(minuteText(screen));
  return 0;
}

function nextScreen(root) {
  const fresh = isFreshWorkspace(root);
  if (fresh) {
    return {
      fresh: true,
      screen: buildFirstMinute({ root, fresh: true }),
    };
  }
  return {
    fresh: false,
    screen: buildFirstMinute({
      root,
      fresh: false,
      context: loadContext(root),
    }),
  };
}

function speakNext(root, { asJson = false, log = console.log } = {}) {
  const { fresh, screen } = nextScreen(root);
  if (asJson && fresh) {
    log(JSON.stringify(freshMinuteJson(folderName(root), listUserVisibleWork(root), { root }), null, 2));
    return 0;
  }
  return printMinute(screen, { asJson, log, fresh });
}

function cardLabel(card) {
  return String(card?.label || card?.title || '').trim();
}

function cardNextCommand(card) {
  if (!card) return '';
  const action = card.next_action || {};
  const prompt = String(action.prompt || '').trim();
  if (/^(atris|ax)\b/i.test(prompt)) return prompt;
  if (action.type === 'mission_complete' && action.mission_id) {
    if (action.proof_path) {
      return `atris mission complete ${action.mission_id} --proof ${action.proof_path}`;
    }
    return `atris mission status ${action.mission_id}`;
  }
  if (action.type === 'mission_review_prompt' && action.mission_id) {
    return `atris mission status ${action.mission_id}`;
  }
  if (action.type === 'wish_answer_prompt') return 'atris wish answer "your words"';
  if (card.source === 'inbox') return 'atris plan';
  if (card.source === 'task' || card.source === 'roadmap' || card.source === 'endgame') {
    return 'atris do';
  }
  if (card.source === 'mission') {
    const id = action.mission_id || card.ref;
    return id ? `atris mission status ${id}` : 'atris mission status --status active';
  }
  return '';
}

function speakCard(card, { asJson = false, log = console.log } = {}) {
  if (!card) {
    return printMinute({ text: 'nothing is waiting.', nextCommand: '' }, { asJson, log });
  }
  const next = cardNextCommand(card);
  const label = cardLabel(card) || 'this';
  return printMinute({
    text: `${label} is waiting.`,
    nextCommand: next,
  }, { asJson, log });
}

function wishPromptTitle(label) {
  return String(label || 'this').replace(/^(#\d+)\s+/, '$1: ');
}

function printWishAnswerPrompt(card, log = console.log) {
  const action = card.next_action || {};
  log(`Got it, wish ${wishPromptTitle(action.label || cardLabel(card))}.`);
  log(String(action.question || 'What should be different when this wish comes true?'));
  log('Answer with: atris wish answer "your words"');
  return 0;
}

function approveMove(card, root, log = console.log) {
  recordDecision(root, card, 'approve', new Date().toISOString());
  if (['roadmap', 'inbox', 'endgame'].includes(card.source)) {
    seedInboxFromMove(root, card);
    if (card.source === 'roadmap') claimRoadmapItem(root, card.title);
    log(`${cardLabel(card)} is working.`);
    return 0;
  }
  const prompt = card.next_action && card.next_action.prompt;
  log(prompt || `${cardLabel(card)} is working.`);
  return 0;
}

function completeMissionFromCard(card, log = console.log) {
  const action = card.next_action || {};
  if (!action.mission_id || !action.proof_path) {
    log('Review the proof, then complete this mission.');
    return 0;
  }
  const { completeMission } = require('./mission');
  completeMission([action.mission_id, '--proof', action.proof_path]);
  return 0;
}

function executeCard(card, root, log = console.log) {
  const action = card && card.next_action;
  if (!card) return speakCard(null, { log });
  if (action?.type === 'wish_answer_prompt') return printWishAnswerPrompt(card, log);
  if (action?.type === 'mission_complete') return completeMissionFromCard(card, log);
  if (action?.type === 'wish_review_prompt' || action?.type === 'mission_review_prompt') {
    log(action.prompt || 'Review the proof, then choose done or stuck.');
    return 0;
  }
  return approveMove(card, root, log);
}

function actionToken(args = []) {
  const list = Array.isArray(args) ? args : [];
  const token = list.find((arg) => {
    const text = String(arg || '').trim();
    if (!text || text.startsWith('-')) return false;
    return true;
  });
  return String(token || '').trim().toLowerCase();
}

function nextCommand(args = [], root = process.cwd(), { log = console.log } = {}) {
  const list = Array.isArray(args) ? args : [];
  if (argsWantHelp(list)) return showHelp(log);

  const asJson = wantsJson(list);
  const action = actionToken(list);

  if (!action || action === 'json') return speakNext(root, { asJson, log });

  const current = nextCards(root, 1)[0] || null;

  if (action === 'skip') {
    const following = current ? nextCards(root, 1, { skipIds: [current.id] })[0] : null;
    if (current?.source === 'dream') {
      markDreamCardConsumed(root, current, new Date().toISOString(), 'skipped');
    }
    if (following?.source === 'dream') {
      markDreamCardConsumed(root, following, new Date().toISOString(), 'dealt');
    }
    return speakCard(following, { asJson, log });
  }

  if (action === 'no') {
    if (!current) return speakCard(null, { asJson, log });
    parkNextCard(root, current);
    log(`Parked ${cardLabel(current)}.`);
    return 0;
  }

  if (action === 'yes') return executeCard(current, root, log);

  return speakNext(root, { asJson, log });
}

module.exports = {
  cardNextCommand,
  minuteJson,
  minuteText,
  nextCommand,
};
