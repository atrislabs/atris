'use strict';

const INTENTS = Object.freeze([
  Object.freeze({
    id: 'next_work',
    say: Object.freeze(['what should i do next', 'what is next', 'pick the next thing', 'what do we do now']),
    do: 'atris next',
    plain: 'your agent picks the most useful next step and starts it.',
    offer: 'boot_empty',
  }),
  Object.freeze({
    id: 'keep_going',
    say: Object.freeze(['keep going while i\'m away', 'run overnight', 'finish this', 'keep working without me']),
    do: 'atris spaceship',
    plain: 'your agent keeps working for a few hours and sends updates.',
    offer: 'boot_empty',
    confirm: true,
  }),
  Object.freeze({
    id: 'improve_one_thing',
    say: Object.freeze(['make it better', 'make it faster', 'ship one thing', 'improve this', 'find one useful improvement']),
    do: 'atris improve tick',
    plain: 'your agent finds one useful improvement, makes it, and checks the result.',
    offer: 'after_landing',
  }),
  Object.freeze({
    id: 'clean_up',
    say: Object.freeze(['clean this up', 'it is messy', 'organize this project', 'tidy the loose ends']),
    do: 'atris clean',
    plain: 'your agent finds stale or messy project files and cleans up the safe ones.',
    offer: 'after_landing',
  }),
  Object.freeze({
    id: 'find_or_explain',
    say: Object.freeze(['where is x', 'how does x work', 'where does this live', 'show me where this lives', 'explain this code']),
    do: 'read atris/MAP.md',
    plain: 'your agent reads the project map and points you to the exact files.',
    offer: 'always',
    file: true,
  }),
  Object.freeze({
    id: 'remember_this',
    say: Object.freeze(['remember this', 'save this', 'do not lose this', 'keep this for later']),
    do: 'atris later "<their words>"',
    plain: 'your agent saves this as a note for later.',
    offer: 'always',
  }),
  Object.freeze({
    id: 'schedule_work',
    say: Object.freeze(['every day', 'every morning', 'on a schedule', 'run this regularly']),
    do: 'atris loop',
    plain: 'your agent sets up repeated work on the schedule you describe.',
    offer: 'always',
    confirm: true,
  }),
  Object.freeze({
    id: 'build_an_idea',
    say: Object.freeze(['i want to build x', 'here is an idea', 'can we make x', 'turn this idea into something']),
    do: 'atris wish "<their words>"',
    plain: 'your agent turns the idea into a clear job and starts once any gaps are answered.',
    offer: 'always',
  }),
  Object.freeze({
    id: 'catch_up',
    say: Object.freeze(['catch me up', 'what happened', 'what landed', 'show me recent progress']),
    do: 'atris recap',
    plain: 'your agent summarizes what changed and what still needs attention.',
    offer: 'always',
  }),
  Object.freeze({
    id: 'check_the_work',
    say: Object.freeze(['is this done', 'is it safe', 'check it', 'review this work', 'can i trust this']),
    do: 'atris review',
    plain: 'your agent checks the work, names any risks, and reports whether it is ready.',
    offer: 'after_landing',
  }),
  Object.freeze({
    id: 'use_fewer_credits',
    say: Object.freeze(['use a free model', 'use a cheaper model', 'do not burn credits', 'save credits', 'switch to the fast model']),
    do: 'atris engine atris-fast',
    plain: 'your agent switches this project to the included fast model to spend fewer credits.',
    offer: 'always',
  }),
  Object.freeze({
    id: 'hand_off_work',
    say: Object.freeze(['hand this off', 'have someone else do it', 'delegate this', 'give this to a teammate']),
    do: 'atris task delegate "<their words>" --to <member>',
    plain: 'your agent gives the work to the best available teammate and keeps the handoff visible.',
    offer: 'always',
    confirm: true,
  }),
  Object.freeze({
    id: 'show_or_set_up_team',
    say: Object.freeze(['who owns this', 'set up a team', 'who is responsible', 'show me the team']),
    do: 'atris team',
    plain: 'your agent shows who is responsible and helps fill any missing role.',
    offer: 'always',
  }),
  Object.freeze({
    id: 'speak_plainly',
    say: Object.freeze(['talk plainer', 'too much jargon', 'use plain english', 'keep it simple']),
    do: 'atris clarity --set voice=plain',
    plain: 'your agent saves your preference for short, plain replies.',
    offer: 'always',
  }),
  Object.freeze({
    id: 'set_goal',
    say: Object.freeze(['our goal is x', 'we are trying to x', 'set the goal', 'keep everyone focused on x']),
    do: 'atris goal set "<their words>"',
    plain: 'your agent saves the goal so future work stays pointed at it.',
    offer: 'always',
  }),
  Object.freeze({
    id: 'show_capabilities',
    say: Object.freeze(['what can you do', 'how can you help', 'show me my options', 'what should i ask for']),
    do: 'atris guide',
    plain: 'your agent shows the things it can handle in words you already use.',
    offer: 'always',
  }),
]);

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'can', 'could', 'for', 'i', 'im', 'is', 'it', 'me', 'my',
  'of', 'on', 'please', 'the', 'this', 'to', 'we', 'you', 'your',
]);

function normalizedTokens(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .match(/[a-z0-9]+/g) || [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word)));
}

function tokenOverlapScore(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  if (!overlap) return 0;
  return (2 * overlap) / (left.size + right.size);
}

function intentScore(tokens, intent) {
  return intent.say.reduce((best, phrase) => (
    Math.max(best, tokenOverlapScore(tokens, normalizedTokens(phrase)))
  ), 0);
}

function matchIntent(text) {
  const tokens = normalizedTokens(text);
  const ranked = INTENTS
    .map((intent, index) => ({ intent, score: intentScore(tokens, intent), index }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  // A 0.46 F1 threshold needs about half of the meaningful words to overlap.
  // It catches natural additions such as "please make this faster" while
  // refusing requests that share only one generic word with a phrase.
  const threshold = 0.46;
  if (!ranked.length || ranked[0].score < threshold) {
    return { intent: null, alternatives: ranked.slice(0, 3).map((item) => item.intent) };
  }

  return {
    intent: ranked[0].intent,
    score: Number(ranked[0].score.toFixed(3)),
    alternatives: ranked.slice(1, 3).map((item) => item.intent),
  };
}

module.exports = { INTENTS, matchIntent };
