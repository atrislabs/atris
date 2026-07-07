'use strict';

const {
  claimRoadmapItem,
  nextCards,
  parkNextCard,
  recordDecision,
  seedInboxFromMove,
} = require('../lib/next-moves');

function showHelp() {
  console.log('');
  console.log('Usage: atris next [yes|no|skip]');
  console.log('');
  console.log('Shows one next move card.');
  console.log('');
  return 0;
}

function cardLabel(card) {
  return String(card?.label || card?.title || '').trim();
}

function cardWhy(card) {
  const why = String(card?.why || '').trim();
  if (why) return why;
  const status = String(card?.status || '').trim();
  if (status) return status;
  if (card?.source === 'task' || card?.source === 'mission') return 'working';
  return 'new';
}

function renderCard(card) {
  if (!card) return 'Nothing to do. Rest or wish.';
  return [
    cardLabel(card),
    `Why now: ${cardWhy(card)}`,
    'Do it? yes / no / skip',
  ].join('\n');
}

function printCard(card) {
  console.log(renderCard(card));
}

function wishPromptTitle(label) {
  return String(label || 'this').replace(/^(#\d+)\s+/, '$1: ');
}

function printWishAnswerPrompt(card) {
  const action = card.next_action || {};
  console.log(`Got it, wish ${wishPromptTitle(action.label || cardLabel(card))}.`);
  console.log(String(action.question || 'What should be different when this wish comes true?'));
  console.log('Answer with: atris wish answer "your words"');
  return 0;
}

function approveMove(card, root) {
  recordDecision(root, card, 'approve', new Date().toISOString());
  if (['roadmap', 'inbox', 'endgame'].includes(card.source)) {
    seedInboxFromMove(root, card);
    if (card.source === 'roadmap') claimRoadmapItem(root, card.title);
    console.log(`${cardLabel(card)} is working.`);
    return 0;
  }
  const prompt = card.next_action && card.next_action.prompt;
  console.log(prompt || `${cardLabel(card)} is working.`);
  return 0;
}

function completeMissionFromCard(card) {
  const action = card.next_action || {};
  if (!action.mission_id || !action.proof_path) {
    console.log('Review the proof, then complete this mission.');
    return 0;
  }
  const { completeMission } = require('./mission');
  completeMission([action.mission_id, '--proof', action.proof_path]);
  return 0;
}

function executeCard(card, root) {
  const action = card && card.next_action;
  if (!card) {
    printCard(null);
    return 0;
  }
  if (action?.type === 'wish_answer_prompt') return printWishAnswerPrompt(card);
  if (action?.type === 'mission_complete') return completeMissionFromCard(card);
  if (action?.type === 'wish_review_prompt' || action?.type === 'mission_review_prompt') {
    console.log(action.prompt || 'Review the proof, then choose done or stuck.');
    return 0;
  }
  return approveMove(card, root);
}

function nextCommand(args = [], root = process.cwd()) {
  const action = String(args[0] || '').trim().toLowerCase();
  if (action === 'help' || action === '--help' || action === '-h') return showHelp();

  const current = nextCards(root, 1)[0] || null;
  if (!action) {
    printCard(current);
    return 0;
  }

  if (action === 'skip') {
    const following = current ? nextCards(root, 1, { skipIds: [current.id] })[0] : null;
    printCard(following);
    return 0;
  }

  if (action === 'no') {
    if (!current) {
      printCard(null);
      return 0;
    }
    parkNextCard(root, current);
    console.log(`Parked ${cardLabel(current)}.`);
    return 0;
  }

  if (action === 'yes') return executeCard(current, root);

  console.log('Say yes, no, or skip.');
  return 2;
}

module.exports = {
  cardLabel,
  nextCommand,
  renderCard,
};
