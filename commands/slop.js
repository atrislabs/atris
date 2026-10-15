// atris slop, deterministic frontend-slop detector (no LLM).
//
// Steal-from-Impeccable, the Atris way: makes "looks AI-generated" concrete and
// CHECKABLE. A failure is a fact (file:line + rule), not a taste opinion, so it
// drops straight into the autopilot/review verification gate and CI. Each finding
// is the seed of a typed lesson; the ruleset is meant to GROW from lessons.md
// rather than be hand-curated forever.
//
// Zero external deps (Node built-ins only), repo contract.
//
// Usage:
//   atris slop detect [path...]      # scan one or more files or dirs (default: .)
//   atris slop detect src/ --json   # machine output for CI / the loop
//   atris slop detect src/ --quiet  # only print the summary line
//
// Exit code: 0 = clean, 1 = slop found, 2 = bad usage. CI/PR gates read this.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const escapeRegExp = require('../lib/escape-regexp');

const SCAN_EXTS = new Set(['.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.ts', '.js', '.mjs', '.html', '.vue', '.svelte', '.astro',
  '.md', '.mdx', '.txt']); // prose too: the voice doctrine (em-dash, hype-copy) is enforceable, not just advice
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', 'coverage', '.cache', 'out', 'vendor']);

// Em dash repair. A list item that opens with a short label and a dash
// ("- **Name** then a dash then what it does") gets a colon after the label,
// and so does a bold label or a code span that opens a plain line or a quote.
// Two dashes around an aside become parentheses, so "the gate, the one CI
// runs, blocks it" never comes out as a comma run-on. A lone dash left over
// becomes a comma, unless punctuation already sits beside it. A dash between
// two numbers is a range ("pages 10 to 20"), so it becomes a hyphen; a comma
// there would turn one range into two separate numbers. A number that runs
// into a hyphen after the dash (a date, "8-regular") is not the end of a
// range, so that dash is fixed like any other. A dash that opens
// the line (a quote attribution) is dropped; a comma cannot start a line.
// A run of dashes in a row is one break, so it is fixed as a single dash.
// Two dashes with a sentence end between them are not an aside; each one is
// fixed alone, so no parenthesis opens in one sentence and closes in another.
// A dash that ends a line stays a comma when the sentence wraps onto the
// next line, and becomes a period when the paragraph ends there.
// A dash before a joining word ("Redis, SQS, and more") continues the
// sentence, so a list item like that is not a label and keeps a comma.
// A list item inside a quote ("> - item") is a label the same way.
// An item that already holds a colon and a short value of four words or
// fewer is a field, so the dash goes on with the value instead of stacking
// a second colon: "risk: none, verification only", never "risk: none:
// verification only". A longer value is a sentence its dash explains.
const LIST_LABEL_DASH = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)((?![^\u2014]*:\s+(?:[^\s\u2014]+\s+){0,3}[^\s\u2014]+\s*\u2014)[^\u2014]{0,59}[^\s\u2014,;:.])\s*\u2014\s*(?!\s|(?:and|but|or|nor|so|yet)\b)/i;
// A bold or italic label or a code span that opens a line or a quote, not a
// list item, gets the same colon: "`npm test` then a dash then 9 tests",
// "_Note_: requires Node 18". An italic mark must touch its word, so a "* "
// list marker never counts. In markdown the fixer sees inline code masked,
// so the masked span counts as code too.
const LINE_LABEL_DASH = /^(\s*(?:>\s*)*)(\*\*[^*\u2014]{0,58}[^\s*\u2014]\*\*|__[^_\u2014]{0,58}[^\s_\u2014]__|\*[^*\s\u2014](?:[^*\u2014]{0,57}[^\s*\u2014])?\*|_[^_\s\u2014](?:[^_\u2014]{0,57}[^\s_\u2014])?_|`[^`]+`|\uE000\d+\uE001)\s*\u2014\s*/;

// A numbered name that opens a line, alone or after a bold label that ends in
// its colon, is a label too: "Class 1: 8-regular graphs", "**Next:** Tick 2: wire it".
// Only known label words count, so "Shipped 3, the rest wait" keeps its comma.
const NUMBERED_LABEL_DASH = /^(\s*(?:>\s*)*(?:(?:\*\*|__)[^*_\u2014]+:(?:\*\*|__)\s+)?)((?:Class|Step|Phase|Stage|Tick|Round|Part|Level|Tier|Day|Week|Wave|Batch|Sprint|Track|Option|Plan|Version|Section|Chapter|Case|Task|Item|Slice|Pass|Milestone) (?:\d+[a-z]?|[A-Z])(?:\.\d+)?)\s*\u2014\s*/;

// A heading with one dash is a title and a subtitle, so the dash becomes a
// colon: "Audit Gaps: Build Plan". It stays a comma when a colon already
// sits before it, or when the subtitle opens with a joining word ("and").
// A colon inside a time is no label, so "## 11:44 · tick 9: OBL-19 shipped"
// and "### Tick 4 (03:05-03:15 PDT): E1 rollup landed" still take one. A
// heading that is only a time keeps its comma, since a colon after it reads
// as seconds: "## 08:25, evidence-pack run", never "## 08:25: evidence".
// A subtitle that holds a colon of its own keeps the comma too, so no
// heading holds two: "## 2026-02-21, Day 0: Agent Initialized", never
// "## 2026-02-21: Day 0: Agent Initialized". A colon with no space after it
// is part of a word or a link ("design:review", "https://").
// A last dash before a joining word goes on with the subtitle and takes a
// comma: "## Setup: install it, then run it".
const HEADING_DASH = /^(\s{0,3}#{1,6}\s+(?![\d\s\u2013-]*\d:\d[\d:\s\u2013-]*(?:(?:PT|PDT|PST|ET|EDT|EST|UTC|Z|am|pm)\s*)?\u2014)(?:[^\u2014:]|(?<=\d):(?=\d))*[^\s\u2014,;:.!?])\s*\u2014\s*(?!(?:and|but|or|nor|so|yet)\b)(?=[^\s\u2014](?:[^\u2014:]|:(?!\s))*(?:\u2014\s*(?:and|but|or|nor|so|yet|then)\b[^\u2014]*)?$)/i;
// A bold phrase that is the whole line stands as a heading and gets the same
// colon: "**Source A: arxiv API**". A dash inside parentheses is left alone.
// A last dash before a joining word takes a comma, as in a heading, and so
// does one whose subtitle holds a colon: "**Server, Tier 1: WebRTC remote**".
// A name that opens a paragraph, then a dash, is a term being defined, so the
// dash becomes a colon: "MEMBER.md: an open-source standard", "v2: shipped".
// Only a name shape counts (a digit, dot, slash, underscore, or two capitals),
// so a plain opener like "Yes" or "Then" keeps its comma. A second dash on the
// line means an aside, so the line is left to the pair fix, unless that dash
// is the last one and comes before a joining word, so it goes on with the
// sentence: "v2: shipped, then rolled back". A code comment that opens a
// file with its own name defines it the same way: "// det/date.js: convert
// dates".
const TERM_DASH = /^(\s*(?:>\s*)*(?:\/\/+[ \t]*)?(?=[\w./-]*?(?:[\d/_]|\.\w|[A-Z][\w./-]*[A-Z]))[A-Za-z0-9][\w./-]*[^\s.\u2014,;:])\s*\u2014\s*(?=\S)(?!(?:and|but|or|nor|so|yet)\b)(?![^\u2014]*\u2014(?!\s*(?:and|but|or|nor|so|yet|then)\b[^\u2014]*$))/;
// A quote that opens with a name, or a few names, then a dash speaks to
// them, so the names take a comma like a greeting: '"George, Nick, covering
// all of Milwaukee County is a serious operation"', never "George, Nick:".
const NAME_ADDRESS_DASH = /((?:^|[\s(])["\u201c])((?:Dr\.\s+)?[A-Z][a-z]+(?:-[A-Z][a-z]+)?(?:,\s+(?:Dr\.\s+)?[A-Z][a-z]+(?:-[A-Z][a-z]+)?){0,3})\s*\u2014\s*(?=[A-Za-z0-9])/g;
// A dated lesson, "- **[2026-05-11] slug** \u2014 pass \u2014 what was learned", is
// read back by the lesson tools, which take a dash or a hyphen between its
// parts and nothing else, so those dashes become spaced hyphens; a colon or
// parentheses there would hide the lesson from them. A scorecard is the same
// head with a run of fields after it, "shipped: 3/4 \u2014 halt: 0% \u2014 reward: 12",
// and its reader needs a hyphen between every field.
const LESSON_DASH = /^(\s*[-*]\s+\*\*\[\d{4}-\d{2}-\d{2}\]\s+[^*]+\*\*)\s*\u2014\s*(?:(pass|fail)\s*\u2014\s*)?/i;
// A journal heading that ends in a clock time, "### Tick 14 \u2014 21:25", is read
// back by analytics for the hour, which takes a dash or a spaced hyphen before
// the time, so it keeps a spaced hyphen. A colon would hide the hour, and the
// range rule would glue the two numbers into "Tick 14-21:25".
const TIMED_HEADING_DASH = /^(\s{0,3}#{1,6}\s.*?\S)\s*\u2014\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
// A greeting that opens a line, then a dash, is a salutation, and a
// salutation takes a comma: "Hey Mark," on its own line, never "Hey Mark.",
// and "Hey [Name], I run an AI company", never a semicolon.
const GREETING_DASH = /^(\s*(?:>\s*)*["\u201c]?(?:Hey|Hi|Hello|Dear)\s+[^\s\u2014.!?:;][^\u2014.!?:;]{0,40}?)\s*\u2014[ \t]*/;
// Two to four capitalized words that open a paragraph are a title, and the
// words after the dash describe it: "Inbox Triage: 23 emails processed".
const TITLE_DASH = /^(\s*(?:>\s*)*[A-Z][a-z0-9'\u2019-]+(?:\s+[A-Z][a-z0-9'\u2019-]+){1,3})\s*\u2014\s*(?=\S)(?!(?:and|but|or|nor|so|yet)\b)(?![^\u2014]*\u2014(?!\s*(?:and|but|or|nor|so|yet|then)\b[^\u2014]*$))/;
const BOLD_HEADING_DASH = /^(\s*(?:>\s*)*(?:\*\*|__)[^\u2014:*_(]*[^\s\u2014,;:.!?*_(])\s*\u2014\s*(?!(?:and|but|or|nor|so|yet)\b)(?=[^\s\u2014:](?:[^\u2014*_:]|:(?!\s))*(?:\u2014\s*(?:and|but|or|nor|so|yet|then)\b[^\u2014*_]*)?(?:\*\*|__)\s*$)/i;

// True when one pair of parentheses wraps the whole aside, "(mostly)" but
// not "(a) or (b)", so the fixer keeps them instead of adding a second pair.
// True when text leaves a parenthesis open, so what follows sits inside it.
function insideParens(s) {
  return (s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length;
}

function wrappedInParens(s) {
  if (s[0] !== '(' || s[s.length - 1] !== ')') return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0 && i < s.length - 1) return false;
  }
  return depth === 0;
}

// A word-only phrase of one to four words, then a list of three or more of
// them separated by commas, ending the sentence or the line, or closing a
// bracket the dash sits inside: "(the mechanical 80%: scaffolding, grids,
// state matrices)", so the number is not read as one of the items. Items that
// open with "when" or "if" are clauses, not a list: "when it fills, if it
// stalls, drain it". A dot inside a word is a site or file name, so
// "steal from places you like: linear.app, vercel.com, arc browser".
const LIST_ITEM = "[A-Za-z0-9][\\w'/-]*(?:\\.\\w[\\w'/-]*)*(?: [A-Za-z0-9][\\w'/-]*(?:\\.\\w[\\w'/-]*)*){0,3}";
const LIST_AFTER_DASH = new RegExp(`(?<=[\\w)\\]*_\`%])\\s*\u2014\\s*(?!(?:and|but|or|nor|so|yet|then|once|when|whenever|if|unless|until|after|before|while) )(?=${LIST_ITEM}(?:, ${LIST_ITEM}){1,}, (?:and |or )?${LIST_ITEM}(?:[.!?](?:\\s|$)|$|(\\))))`, 'g');
// A sentence so far that is only a list of three or more short or quoted
// items, with "and" or "or" before the last one or not.
const BARE_ITEM = `(?:${LIST_ITEM}|"[^"]+"|\u201c[^\u201d]+\u201d)`;
const BARE_LIST = new RegExp(`^${BARE_ITEM}(?:(?:, ${BARE_ITEM}){2,}|(?:, ${BARE_ITEM})+,? (?:and|or) ${BARE_ITEM})$`);
// The short words a title leaves in lowercase: "The Lord of the Rings".
const TITLE_SMALL_WORD = /^(?:a|an|the|and|but|or|nor|of|in|on|at|to|by|for|with|from|as|vs)$/;
// One to three words after a dash that end the sentence, the tail a list
// may close with. A joining word goes on with the sentence instead.
const LIST_TAIL_DASH = /\s*\u2014\s*(?!(?:and|or|but|nor|so|yet|then|etc)\b)([A-Za-z0-9][\w'-]*(?: [A-Za-z0-9][\w'-]*){0,2})(?=[.!?]["'\u201d\u2019)]*(?:\s|$)|\s*$)/g;
// Three or more phrases that each open with an "ing" word list what the
// sentence before does, however long each one runs, so they take a colon too:
// "Sessions build on each other: extracting what was learned, understanding
// the progression, and intelligently suggesting the next topic". Without
// this, "extracting what was learned" reads as a subject and its verb.
const ING_ITEM = "(?:[a-z]+ly )?(?!(?:some|any|every|no)?thing\\b|during\\b|morning\\b|evening\\b|string\\b)[a-z]{2,}ing\\b[^,.!?;:\\u2014]*";
// A field whose value is one verdict word, "risk: none" or "R2: PASS", is
// only backed up by a list after its dash, so the list takes a comma, not a
// second colon: "risk: none, read-only, no credits spent, no state mutated".
// Any other value may be what the list spells out ("All Postgres data:
// conversations, configs"), so that keeps its colon.
const VERDICT_FIELD = /:[*_]*\s+(?:\*\*|__)?(?:none|n\/a|pass|passed|fail|failed|ok|okay|yes|no|done|clean|green|red|blocked|held|skip|skipped|unchanged|true|false)(?:\*\*|__)?$/i;
const ING_LIST_AFTER_DASH =new RegExp(`(?<=[\\w)\\]*_\`%])\\s*\u2014\\s*(?=${ING_ITEM}(?:, ${ING_ITEM}){1,}, (?:and |or )?${ING_ITEM}(?:[.!?](?:\\s|$)|$))`, 'g');

// A lone dash with a word before it, then a subject pronoun and its verb:
// "it survives", "they'd pass", "that's the goal". "This" and its kin count
// only before a verb, so "the gap, this time with tests" stays a comma.
// A masked code span before the dash counts as the word: "Do not use `PUT`".
const CLAUSE_AFTER_DASH = /(?<=[\w)\]"'*_`%\u201d\u2019\uE001])\s*\u2014\s*(?=(?:(?:it|we|they|you|I|he|she)(?:['\u2019](?:s|re|ll|ve|d|m))?|(?:this|that|these|those|there)(?:['\u2019]s|\s+(?:is|are|was|were|used|will|would|can|cannot|must|should|has|have))\b)\s+[^\s\u2014])/g;
// A noun subject and its helping verb start a second sentence too: "is not a
// twin, restart is allowed". "Did", "could", "had" and their kin count as
// helping verbs too: "still open, receipt did not move it". So do common
// plain verbs after a noun subject: "an hour old, the tick runs". Up to
// five plain words reach the verb, none of them a joining word, so "not X,
// even when the build is red" keeps its comma. A second "the" or a "that"
// means a phrase with a clause inside it, "the verb the fleet runs", so the
// dash there keeps its comma. So does a naming word with more words before
// the verb, which restates what came before: "the same intersection, the
// next thing /autopilot should ship". One short place phrase may sit between
// the subject and its verb, with its own "the": "the counting slack at degree
// 4 is only 2", "the oldest job in the queue is stale". A verb that reports
// a fact, with its "that" left off, is no subject word: "endpoint null,
// proves instance was stale" keeps its comma, but "settings file is stale"
// still joins. Only past forms that never describe a noun count, so
// "suggested fix is ready" and "confirmed bugs are fixed" still join.
const REPORT_VERB = '(?:proves|shows|means|suggests|confirms|implies|indicates|says|ensures|guarantees|proved|showed|meant)';
// A word may hold one "=" joining a name and its value, as in a math or
// config note: "the published figure at n=43 was not checked".
const NOUN_WORD = "(?:[A-Za-z0-9_/'-]+(?:\\.[A-Za-z0-9_]+)*(?:=[A-Za-z0-9_'-]+(?:\\.[A-Za-z0-9_]+)*)?|\\uE000\\d+\\uE001)";
// a word that only says when or how often is never the first word of a
// subject: "The tool we built, now ships to everyone".
const WHEN_WORD = '(?:now|already|never|always|finally|soon|often|usually|really|actually)';
const SUBJECT_WORD = `(?:(?!(?:and|but|or|nor|so|yet|then|not|even|when|if|unless|until|because|since|while|where|which|who|as|after|before|though|although|once|just|only)\\b)${NOUN_WORD}\\s+)`;
const HELPING_VERB = '(?:is|are|was|were|will|would|can|cannot|could|must|should|may|might|has|have|had|does|did|exists|gets|got|needs|keeps|makes|runs|takes|goes|stays|means)';
const ASIDE_THEN_HELPER = new RegExp(`\\)\\s+${HELPING_VERB}\\b`, 'g');
const NAMING_WORD = '(?:thing|one|part|piece|kind|place|point|moment|step|move|reason|question|answer)s?';
const NAMING_PHRASE = `(?:the|a|an)\\s+(?:(?:next|only|same|first|last|real|one)\\s+)?${NAMING_WORD}\\s+(?!(?:${HELPING_VERB}|${NAMING_WORD})\\b)`;
const PLACE_PHRASE = `(?:(?:at|in|on|of|for|from|under|per)\\s+(?:(?:the|a|an)\\s+)?(?:(?!(?:the|a|an|that|whose)\\b)${SUBJECT_WORD}){1,2})?`;
// "Each time" or "every time" opens a "when" clause, not a subject, so
// "the cache warms up, each time CI runs the suite" keeps its comma.
const TIME_OPENER = '(?:each|every|any|no)\\s+time\\b';
// A line may wrap right after a helper that leaves the sentence open, so
// "Nothing is broken, one request flag is" ends a clause that goes on below.
// Verbs like "runs" or "have" can end a phrase ("nice to have"), so only
// these count there. A helper in capitals is stress, not a new word, so
// "labels are noise, the placeholder IS the label" joins like "is" does.
const CAPS_HELPER = '(?:IS|ARE|WAS|WERE|WILL|CAN|MUST|HAS|HAVE|DOES|DID)';
const OPEN_HELPER = '(?:is|are|was|were|will|would|can|cannot|could|must|should|may|might|has|had|does|did)';
// A quoted phrase is a subject too, alone or two joined by "and", when a
// verb like "is" follows it: 'be specific; "direct" is better than
// "helpful"'. A quote with no verb after it stays a phrase.
const QUOTED_PART = '(?:"[^"\\u2014]{1,80}"|\\u201c[^\\u201c\\u201d\\u2014]{1,80}\\u201d)\\s+';
const QUOTED_SUBJECT = `${QUOTED_PART}(?:and\\s+${QUOTED_PART})?`;
const NOUN_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${NAMING_PHRASE})(?!${WHEN_WORD}\\b)(?!${TIME_OPENER})(?!${REPORT_VERB}\\s)(?=(?:${QUOTED_SUBJECT}|${SUBJECT_WORD}(?:(?!(?:the|a|an|that|whose)\\b)${SUBJECT_WORD}){0,4}${PLACE_PHRASE})(?:(?:${HELPING_VERB}|${CAPS_HELPER})\\s+[^\\s\\u2014]|${OPEN_HELPER}$))`, 'g');
// "Nothing", "everything" and their kin before a plain verb in "ed" or "s"
// are a subject too: "the gate held, nothing in the queue moved". A word in
// "ss" is never the verb, so "nothing less than" and "nothing fancy" stay.
// A count and a plural noun before a verb in "ed" are one too: "the fix is
// small, two lines in the fixer changed". A verb in "ed" before "by", "as",
// "for" and their kin describes the noun instead, so "two tests marked as
// flaky" and "12 files touched by the sweep" keep their comma. A common verb
// in the present counts as well: "PASS on Monday; both packs validate
// cleanly", "done; all tests pass now". The list is short on purpose, so
// "two weeks ago" and "three tests flaky" stay asides.
const PRESENT_PLURAL_VERB = '(?:pass|fail|run|work|break|hold|match|agree|validate|load|build|ship|land|compile|apply|need|stay|remain|exist|show|point|wait|block|return)';
const COUNT_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|all|most|some|none|half|both|many|few|\\d+)';
const OF_QUANTITY = `${COUNT_WORD}\\s+of\\s+(?:(?:the|our|its|their|${COUNT_WORD})\\s+)?(?:[^\\s\\u2014]+\\s+){0,2}[^\\s\\u2014]*s["'\\u201d\\uE001]?\\s+(?!(?:from|of|in|on|for|with|at|by|to|and|or|but|that|which|who|like|than|as|into|per|across|today|now|here|there|too|also|only|so)\\b)(?![a-z]+ly\\b)(?:${HELPING_VERB}|[a-z]{2,})\\b`;
const QUANTITY_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?=(?:(?:nothing|everything|nobody|everyone)\\s+(?:else\\s+)?${PLACE_PHRASE}[a-z]{2,}(?:ed|[a-rt-z]s)|(?:two|three|four|five|six|seven|eight|nine|ten|both|several|many|few|\\d+)\\s+(?:[a-z]+\\s+)?[a-z]+s\\s+${PLACE_PHRASE}[a-z]{2,}ed(?!\\s+(?:by|as|for|from|to|into|with|under)\\b)|(?:all|two|three|four|five|six|seven|eight|nine|ten|both|several|many|few|\\d+)\\s+(?:[a-z]+\\s+)?[a-z]+s\\s+${PRESENT_PLURAL_VERB}\\b(?![-'])|${OF_QUANTITY})(?:\\s+[^\\s\\u2014]|[.!?;,]|$))`, 'g');
// "The" and up to three words before a verb in "ed" start one only when a
// stop, a word like "out" or "working", or an object like "every" follows, so
// "the slow tests timed out" joins but "the new signed build" and "the files
// stored in atris" are noun phrases and keep their comma. Common past verbs
// without "ed" count too, and so does "fine" or "green" after the verb: "the
// gate let the tick through", "the file built fine". A "they" or "we" before
// the verb opens a clause inside a noun phrase, so "the version they made"
// and "the version they shipped" keep their comma.
const PAST_VERB = '(?:[a-z]{2,}ed|built|ran|broke|took|made|gave|got|went|came|sent|kept|held|found|lost|wrote|let|caught|brought|threw|grew|knew|began|stood|told|sold|became|fell|stuck)';
const PAST_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${NAMING_PHRASE})(?=(?:the|a|an)\\s+(?:(?!(?:the|a|an|that|whose|they|we|you|he|she|I)\\b)${SUBJECT_WORD}){1,3}${PAST_VERB}(?:[.!?;,]|$|\\s+(?:out|up|down|off|back|over|away|again|fine|green|it|them|its|their|every|all|each|the|a|an|this|no|[a-z]{2,}ing)\\b))`, 'g');
// A plain verb ending in "s" counts only after a determiner and one more word,
// and never right before a preposition: "a stray file turns them" joins, but
// "the changes from whoever" and "the old tests from CI" stay noun phrases.
// Small words that end in "s" are never the verb: "the bug this fix closes".
// A plural noun looks the same ("the decision helpers"), so this path only
// runs after a "not" sentence, where 3 of 3 repo lines read as clauses.
// A "that" or "which" before the verb opens a clause inside the noun
// phrase, so "the parallel that connects the men" keeps its comma.
const PLAIN_VERB_WORD = '(?!(?:this|his|its|was|has|does|thus|plus|always|perhaps|unless|whereas|across)\\b)[a-z]{2,}[a-rt-z]s';
const PLAIN_VERB = PLAIN_VERB_WORD + '\\s+(?!(?:from|of|in|on|for|with|at|by|to|and|or|that|which|who|like|than|as)\\b)';
// A word in "s" before ", which is" is a verb, since a plural noun takes
// "which are": "the unbulleted form works, which is why nobody noticed".
// Nouns in "us", "is" or "ics" and their kin are one thing, so "the build
// status, which is green" and "the metrics, which is" keep their comma.
const VERB_BEFORE_WHICH = PLAIN_VERB_WORD + '(?<![ua]s|is|ics|news|series|species|lens|means),\\s+which\\s+(?:is|was)\\b';
const PLAIN_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${TIME_OPENER})(?=(?:a|an|the|every|each|no)\\s+${NOUN_WORD}\\s+(?:(?!(?:that|which|who|whose)\\b)${NOUN_WORD}\\s+){0,2}(?:${PLAIN_VERB}[^\\s\\u2014]|${VERB_BEFORE_WHICH}))`, 'g');
// Outside a "not" sentence the verb needs "it" or "them" after it with no
// verb of their own, so "the navigator reads it" joins but "the decision
// helpers it uses" and "the decision helpers the CLI uses" stay noun phrases.
// An object with its own "the" counts too when none of its one or two words
// ends in "s" or "ed" and a stop or a word like "on" or "when" ends it: "the
// CLI resolves the prefix", "a tap focuses the next turn on that computer".
// Anything else after it means a clause inside a noun phrase, so "the
// decision helpers the CLI uses" and "the docs the Atris editor renders"
// keep their comma. One word for the state the object ends in may sit
// before that end: "a regression turns the gate red instead of waiting".
// A word in "ly" that says how counts the same way: "the voice
// acknowledges instantly and the agent answers". Words like "mostly"
// and "only" can point at the noun instead, "the tests mostly", so they don't.
const OBJECT_WORD = "(?![a-z]+(?:s|ed)\\b)[A-Za-z0-9_/'-]+";
const MANNER_WORD = '(?!(?:only|mostly|mainly|largely|partly|nearly|merely|simply|exactly|especially|particularly|probably|likely|really|actually|usually|generally|typically|certainly|clearly|apparently|basically|entirely|fully|early|daily|weekly|monthly|yearly|hourly|reply|apply|supply|family|rally)\\b)[a-z]{3,}ly';
const PLAIN_OBJECT_CLAUSE = new RegExp(`^\\s*\\u2014\\s*(?:a|an|the|every|each|no)\\s+${NOUN_WORD}\\s+(?:${NOUN_WORD}\\s+){0,2}(?:${VERB_BEFORE_WHICH}|${PLAIN_VERB}(?:(?:it|them)(?:[.!?;,]|$|\\s+(?![a-z]+(?:s|ed)\\b))|(?:the|a|an|its|their)\\s+(?:${OBJECT_WORD}\\s+)?${OBJECT_WORD}(?:\\s+(?:red|green|fine|clean|stale|empty|safe))?(?:[.!?;,]|$|\\s+(?:on|in|at|to|into|for|from|with|by|via|when|if|before|after|until|once|while|because|instead|rather|without)\\b)|${MANNER_WORD}(?:[.!?;,]|$|\\s+(?:and|but|on|in|at|to|into|for|from|with|by|via|when|if|before|after|until|once|while|because|instead|rather|without)\\b)))`);
// A plain word, then a name, then the verb hides a "that": "a topic Atris
// sits directly on top of" names a topic, so it keeps its comma. A run of
// capitals is no name, so "the new CLI resolves the prefix" still joins.
const NAME_BEFORE_PLAIN_VERB = new RegExp(`^\\s*\\u2014\\s*(?:a|an|the|every|each|no)\\s+(?:${NOUN_WORD}\\s+){0,2}?[a-z][a-z'-]*\\s+[A-Z][a-z]+\\s+${PLAIN_VERB_WORD}\\b`);
// A dash before "once", "when", "if" and their kin starts a second sentence
// when that short clause ends in a comma and a subject and verb follow it:
// "This is the archive; once the endgame closes, future runs can read this".
// The verb may end the sentence: "when it passes, the branch lands".
// "Each time" and "every time" open one like "when" does: "every time a
// tick lands, the gate holds".
// The clause may hold its own commas: "when it fills, if it stalls, drain it".
// A command with "it" or "them" after it is a sentence too: "if it breaks,
// trace it". A joining word there is not a command, so "then it lands" stays.
// With no subject after the comma, or no comma at all, the clause only adds
// a condition, so "Ship it, if you can" and "It fails, when it is full" stay.
const LEADING_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?=(?:once|when|whenever|if|unless|until|after|before|while|(?:each|every|any)\\s+time)\\s+[^.;:!?\\u2014]{1,80}?,\\s+(?:(?!(?:and|but|or|nor|so|yet|then|once|when|whenever|if|unless|until|after|before|while|as|since|because|though|although)\\b)[a-z]{2,}(?<!s|ed|ing)\\s+(?:it|them)\\b|(?:it|we|they|you|I|he|she)(?:['\\u2019](?:s|re|ll|ve|d|m))?\\s+[a-z]|(?:this|that|there)\\s+(?:is|are|was|were|will|would|can|must|should|has|have)\\b|${SUBJECT_WORD}(?:(?!(?:the|a|an|that|whose)\\b)${SUBJECT_WORD}){0,3}${HELPING_VERB}\\s|(?:a|an|the|every|each|no)\\s+${NOUN_WORD}\\s+(?:${NOUN_WORD}\\s+){0,2}(?:${PLAIN_VERB}|${PLAIN_VERB_WORD}(?=[.!?;]|$))))`, 'g');
// A "not" contraction or a word like "still" or "never" right after a
// noun subject marks a verb, which no plain noun phrase has: "the picker
// can't see it", "the member still owns the receipt", "a session never wakes".
// The word after "still" must be a verb, so "the files still open" stays.
// A "that" before it opens a clause inside a noun phrase, so "the same
// surface that already runs it" stays too. The "the" may be left off:
// "PR merged; review queue now loads", "helpers survived; `findAppsTab`
// still reached for it". A joining word is no subject, so "but don't" and
// "not just likes" keep their comma. After a plural, a verb with no "s"
// counts when more words follow it: "diminishing returns now suggest
// moving", "dead sheets still cause conflicts". A verb like "is" right
// after the dash has its subject before it, so the dash closed an aside:
// "the slice, a smoke session, is protected and won't self-land".
const ADVERB_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${NAMING_PHRASE})(?!${TIME_OPENER})(?!${OPEN_HELPER}\\b)(?=(?:(?:the|a|an|every|each|no)\\s+)?(?!(?:and|but|or|nor|so|yet|then|not|even|when|if|unless|until|because|since|while|where|which|who|as|after|before|though|although|once|just|only)\\b)(?:(?!(?:the|a|an|that|whose)\\b)${SUBJECT_WORD}){0,2}(?!(?:that|whose)\\b)${NOUN_WORD}\\s+(?:(?:just|still|never|already|always|now|really|actually|often|usually|rarely|finally)\\s+(?:[a-z]{2,}(?:s|ed)\\b(?<!ss|ous)|(?<=s\\s+(?:now|still|never|already|always|often|usually|rarely|finally|just)\\s+)[a-z]{3,}\\b(?=\\s+[a-z])|(?:is|are|was|were|will|would|can|could|must|should|has|have|had|does|did)\\b|[a-z]+n['\\u2019]t\\b)|[a-z]+n['\\u2019]t\\b))`, 'g');
// One bare word with no "s" and a verb in "s" that moves toward a place
// start one too: "Blocks use overflow, content clips to the bounding box",
// "data flows into the sheet". A plural or a word in "ly" before the verb,
// "tests runs" or "quickly moves", is not a subject. So does one plain word
// after the verb that ends the sentence: '"one font weight"; scarcity forces
// creativity', "not build errors; xcodebuild compiles fine". A "the" or
// "our" is no bare word, so "old code, the tests mostly" keeps its comma.
// A word in "ed" describes the plural after it, so "closed entries
// within" keeps its comma; "speed" and "seed" are still nouns.
// A plural with no "the", then a common verb that is rarely a noun and more
// words after it, starts one too: "small phones overflow silently", "master
// merges do not reach prod". A plural before a noun, "skills folder", is no
// verb, and "the" is left out so "the changes users need" stays a phrase.
const COMMON_PLAIN_VERB = '(?:need|appear|carry|say|do|seem|remain|require|reach|stay|tend|hold|lose|know|want|become|belong|depend|happen|exist|agree|refuse|include|contain)';
const PLURAL_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${NAMING_PHRASE})(?!${TIME_OPENER})(?=(?:(?!(?:the|a|an|that|whose|this|it|its)\\b)${SUBJECT_WORD}){0,2}(?!(?:the|a|an|that|whose|this|its)\\b)[A-Za-z0-9_'-]*[a-z](?<!ss|us|is)s\\s+${COMMON_PLAIN_VERB}\\s+[^\\s\\u2014])`, 'g');
// A "the" subject of one or two words, then a verb in "s" that is rarely a
// noun and more words, starts one too: "keep it short; the config lives in
// one file". A pronoun or "that" before the verb opens a clause inside a
// noun phrase, so "the file it belongs to" stays, and "of" after it marks a
// noun, so "the private lives of founders" stays.
const RARE_NOUN_VERB = '(?:lives|appears|belongs|depends|seems|happens|exists|sits|resides|occurs|arrives|applies)';
const THE_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${TIME_OPENER})(?=(?:the|a|an|every|each|no)\\s+(?:(?!(?:the|a|an|that|whose|which|who|it|they|we|you|he|she|I|this|these|those)\\b)${NOUN_WORD}\\s+){1,2}${RARE_NOUN_VERB}\\s+(?!(?:of|and|or|that|which|who|like|than|as)\\b)[^\\s\\u2014])`, 'g');
// A subject that holds its own "that" clause, a verb in "s" or "ed" right
// after the "that", then a singular "is", "was" or "has", starts one too:
// "say why in the receipt; a stuck loop that reports stuck is healthy". A
// plural like "teams" after the "that" takes "are", so "a plan that teams
// are using" stays a phrase.
const THAT_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?=(?:the|a|an)\\s+(?:(?!(?:the|a|an|that|which|who)\\b)[a-z][\\w-]*\\s+){1,3}that\\s+[a-z]{3,}(?:s|ed)\\s+(?:(?!(?:is|was|has)\\b)[a-z][\\w-]*\\s+){0,2}(?:is|was|has)\\s+[a-z])`, 'g');
// A short subject and a verb that ends its clause start one too, with
// nothing after the verb: "swap the model; the brain stays", "the session
// vanishes; no reusable artifact remains". Only verbs a noun rarely ends in
// count here, so "no code changes" and "the config lives" keep their comma,
// and no word in "s" may sit before the verb, since it can be the real verb:
// "the backend captures runs".
const END_VERB = '(?:remains|stays|works|survives|holds|runs|fails|breaks|helps|vanishes|persists|exists)';
const END_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?=(?:the|a|an|every|each|no)\\s+(?:(?!(?:the|a|an|that|whose|which|who|it|they|we|you|he|she|I|this|these|those|one|ones)\\b)(?![A-Za-z_-]*[a-rt-z]s\\b)${NOUN_WORD}\\s+){1,2}${END_VERB}(?=[.;!?,]|$))`, 'g');
// "Each" takes a verb in "s", so "each", up to four words and a verb in "s"
// with more words after it start one too: "started the loop; each tick
// re-reads the latest logs". No "the", "that" or place word may sit before
// the verb, so "each time the loop runs" and "each with its own tests in CI"
// keep their comma.
const EACH_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${TIME_OPENER})(?=each\\s+(?:(?!(?:the|a|an|that|whose|of|with|in|on|for|from|at|by|to|per|and|or|but)\\b)${NOUN_WORD}\\s+){0,4}(?:[a-z]+-)?${PLAIN_VERB}[^\\s\\u2014])`, 'g');
// A bare word and a plain verb start a clause too, but never a word that
// only says when (see WHEN_WORD). A number word before a word in "s" counts
// a plural noun, never a subject and its verb, so "shipped it, two weeks
// ago" and "three days later" keep their comma.
const BARE_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${NAMING_PHRASE})(?!${WHEN_WORD}\\b)(?=(?!(?:and|but|or|nor|so|yet|then|not|even|when|if|unless|until|because|since|while|where|which|who|as|after|before|though|although|once|just|only|also|still|this|that|it|its|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|many|few|both|the|our|your|their|her|his|any|every|each)\\b)[a-z]{3,}(?<!s|ly|[^e]ed)\\s+${PLAIN_VERB_WORD}\\s+(?:(?:to|into|onto|through)\\s|[a-z]{3,}(?:[.!?;]|$)))`, 'g');
// The same bare word in the past tense starts one too, with "alone" or
// "also" before its verb or not, when an object like "it" or "the" or two
// more words follow, none a preposition: "carry no signal; calibration
// showed annealing misses", "greedy alone decomposed everything". A verb
// in "s" counts when an object like "the" follows it: "the change is
// additive; reverting only removes the section". So "data stored in
// atris", "manual signed builds" and "universal tools that work" stay phrases.
const BARE_VERB_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${NAMING_PHRASE})(?!${WHEN_WORD}\\b)(?=(?!(?:and|but|or|nor|so|yet|then|not|even|when|if|unless|until|because|since|while|where|which|who|as|after|before|though|although|once|just|only|also|still|this|that|it|its|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|many|few|both|the|our|your|their|her|his|any|every|each)\\b)[a-z]{3,}(?<!s|ly|[^e]ed)\\s+(?:(?:alone|also|only|then|just|still|never|always|already|finally)\\s+)?(?:${PAST_VERB}\\s+(?!(?:by|as|for|in|on|at|to|from|with|of|into|onto|over|under|and|or|than|like|via|per)\\b)(?:(?:it|them|him|her|us|everything|nothing|something|anything|all|the|a|an|every|each|this|that|these|those|its|their|our|my|your|his)\\b|[a-z]{2,}\\s+[a-z]{2,})|[a-z]{3,}(?<!ss)s\\s+(?:it|them|him|her|us|everything|nothing|something|anything|all|the|a|an|every|each|its|their|our|my|your|his)\\b))`, 'g');

// "Our", "your", "their" or "my" and one to three words, then a verb, start
// a second sentence too: "Saw your post on falls after rehab; our scheduling
// AI ensures reliable care". With no verb it only renames what came before,
// so "the tool, our best work so far" keeps its comma.
const POSSESSIVE_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?=(?:our|your|their|my)\\s+(?:${NOUN_WORD}\\s+){1,3}(?:${PLAIN_VERB}[^\\s\\u2014]|${HELPING_VERB}\\s+[^\\s\\u2014]))`, 'g');

// A direct question after a full clause is a sentence of its own, so it takes
// a semicolon: "Congrats on the Forbes ranking; how do you handle growing
// demand?" It must end in a question mark. A clause led by "if" or a phrase
// led by "with" that runs up to the dash keeps its comma: "If you had 20
// hours back, where would they go?" Commas inside it may only list names
// ("With clients on Hilton Head, Folly Beach"); a lowercase part after one
// is a second sentence ("As an alum, congrats on the ranking; how...?").
// After "ask" or "wonder" the question is what is asked, so it takes a
// colon: "I have to ask: how do you manage it?"
const QUESTION_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?=(?:(?:how|what|where|why|which|who)(?:['\\u2019]s)?|do|does|did|is|are|was|were|has|have|can|could|would|will|should|any)\\s+[^.!?\\u2014]*\\?)`, 'g');

// An order after a full clause is a sentence of its own, so a comma there is
// a splice: "pruning the worktree deletes proof; copy receipts out first".
// An order can lead a second one after a comma: "done; halt, don't proceed".
// A word after "don't" is always a plain verb, even one that ends in "ed".
// The verb needs a plain word after it, so a noun in a label field ("verify:
// tests pass"), before a past verb ("copy drafted for 1.6"), or before "of"
// ("calendar-probe, fork of relay-probe") keeps its comma.
// "never" stays out: "it never crashes the tick" has its subject left off.
// "Let's" asks the reader to act too: "Congrats on the award; let's talk".
// Two orders side by side are one sentence, so the comma stays: "Kill the
// group at timeout, spawn the phase detached", "don't impose, match it".
const ORDER_VERB = `(?:don['\\u2019]t|do not|let['\\u2019]s|let us|pick|copy|reframe|judge|plug|retry|rename|propose|inspect|keep|leave|use|run|read|ask|add|check|make|move|stop|try|wait|skip|take|look|call|write|delete|remove|fix|put|say|tell|give|treat|verify|ship|commit|push|kill|mark|start|avoid|prefer|trust|drop|cut|split|merge|revert|rerun|re-run|consolidate|pin|automate|clamp|fork|spawn|adapt|halt|search)`;
const ORDER_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?=(?:${ORDER_VERB},\\s+)?(?:don['\\u2019]t|do not)\\s+[\\w\`"'(\\uE000]|${ORDER_VERB}(?:,\\s+${ORDER_VERB})?\\s+(?![a-z]+ed\\b|of\\b)[\\w\`"'(\\uE000])`, 'g');

// Two short subjects joined by "and", then a helper that takes them both,
// start one too: "had no guard; render.py and render_reel.py are coupled",
// "the phone audit and control contract are absent". An order or a helper
// is no subject word, so "it failed, and would have shipped" stays, and
// "how" opens a phrase that explains the noun: "a philosophy of work, how
// companies and agents should run together".
const AND_PART = `(?:(?:the|a|an|our|your|their|its|my)\\s+)?(?:(?!(?:the|a|an|that|whose|this|it|they|we|you|he|she|I|how|what|why|whether|${HELPING_VERB})\\b)${SUBJECT_WORD}){1,3}`;
const AND_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${NAMING_PHRASE})(?!${TIME_OPENER})(?!${ORDER_VERB}\\s)(?=${AND_PART}and\\s+${AND_PART}(?:are|were|have|had|will|would|can|cannot|could|must|should|may|might|do|did)\\s+[^\\s\\u2014])`, 'g');
// A short subject with no "the", then a verb that reports how a run went
// and ends the clause, starts one too: "health tick green; gate
// inbox-contract passed (receipt saved)", "woke up clean; morning protocol
// held". A count before the verb is a tally, so "pass, 3613 passed" and
// "one-time, 122d stalled" keep their comma. An adverb or a preposition is
// no subject, nor is an "ing" verb with its object, so "never deleted, never
// merged" and "done, verifying nothing broke" stay, and so does a list of
// states: "show landed, failed, or waiting".
const STATUS_PAST = '(?:passed|failed|shipped|landed|merged|broke|crashed|stalled|regressed|succeeded|held|worked|reverted|deployed|timed\\s+out)';
const STATUS_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?!${NAMING_PHRASE})(?!${ORDER_VERB}\\s)(?![\\d$])(?=(?!(?:the|a|an|no|${COUNT_WORD}|several|each|every|any|only)\\b)(?![a-z]+ing\\s+(?:nothing|everything|something|anything|the|a|an|it|that|this|all|no|its|their)\\b)(?:(?!(?:the|a|an|that|whose|this|it|they|we|you|he|she|I|how|what|why|whether|to|from|in|of|for|with|by|at|on|into|never|already|always|also|still|now|again|NOT|Not|${HELPING_VERB})\\b)${SUBJECT_WORD}){1,3}${STATUS_PAST}(?!,?\\s+(?:or\\b|[a-z]+ed\\b,))(?:\\s+\\(|[.!?;,]|$|\\s+and\\b))`, 'g');
// "Only" before a subject and its verb starts one too: "tested 6 contact
// pages; only Austin exposed an email", "only the build packet exists".
// With no verb it only narrows what came before, so "only if outbound
// live" and "only the wallet index and public address" keep their comma.
const ONLY_CLAUSE_AFTER_DASH = new RegExp(`(?<=[\\w)\\]"'*_\`%\\u201d\\u2019\\uE001])\\s*\\u2014\\s*(?=only\\s+(?!${ORDER_VERB}\\s)${AND_PART}(?:and\\s+${AND_PART})?(?:${HELPING_VERB}\\s+[^\\s\\u2014]|exists?\\b|${OPEN_HELPER}$|[a-z]{3,}ed\\s+(?!(?:by|as|for|in|on|at|to|from|with|of|into|and|or)\\b)[\\w\\uE000]))`, 'g');

// The mark that joins a full clause to the sentence before the dash. A short
// opener led by "not" has no verb of its own, so the clause explains it and
// takes a colon: "Not exhaustive: the frontier was not extended". A quoted
// term alone is being defined, so the clause after it explains the term and
// takes a colon too: '"Democratic dictatorship": everyone has a voice'.
// A sentence that opens with "when", "if" or their kin and has no comma yet
// is only its first half, so the dash closes that half with a comma: "When
// a lead asks about the pipeline, you answer with numbers". A comma or colon
// already there, even inside a quote or after a bold label, closed it.
function clauseJoin(left) {
  const opener = left.replace(/^(?:(?:[-*+>]|\d+[.)]|\*\*|__)\s*)+/, '');
  if (/^(?:when|whenever|if|unless|until|once|because|since|although|though|while)\b/i.test(opener) && !/[,:]["'\u201d\u2019*_]*\s/.test(opener)) return ', ';
  if (/^not\b/i.test(opener) && opener.split(/\s+/).length <= 3) return ': ';
  // after a semicolon, up to three words with no verb or subject of their
  // own name what the clause says, so it takes a colon: "paused; finding:
  // pause is advisory", "clean; one gap: web never sent a turn id". A word
  // after the first in "ed" or "s" is a verb, so "production delivered 72"
  // is a clause, and a bracket means the semicolon sat inside it.
  const parts = opener.split(/;\s/);
  if (parts.length > 1 && !/[()]/.test(parts[parts.length - 1])) {
    const words = parts[parts.length - 1].replace(/[*_`]/g, '').trim().split(/\s+/);
    if (words[0] && words.length <= 3 && !words.slice(1).some((w) => /(?:ed|[^s]s)$/.test(w)) && !words.some((w) => /^(?:it|this|that|these|those|we|they|you|he|she|I|there|is|are|was|were|will|would|can|could|must|should|has|have|had|does|did|do|not|no)$/i.test(w))) return ': ';
  }
  return /^(?:"[^"]+"|\u201c[^\u201c\u201d]+\u201d)$/.test(opener) ? ': ' : '; ';
}

// The words before the dash in the same sentence, when they can be a clause:
// two words or more, and not a title where every word is capitalized, since
// "Inbox Triage, 23 emails processed" names a thing and has no verb to join.
// Words in all capitals are shouting, not a title: "Lines DO NOT SURVIVE".
// A bold verdict that is a field's whole value says the field is that, so
// "Result: **FAIL**" is a clause: "Result: **FAIL**; the repository has
// no runner", never a comma splice. A fragment after it keeps its comma.
// A stop inside closing bold or italics already ended the sentence, so no
// semicolon stacks on it: '*Who is nobody building?* Every answer', never
// '*Who is nobody building?*; every answer'.
function clauseLeft(at, whole) {
  const verdict = /\S:\s+(\*\*[^*]+\*\*|__[^_]+__)\s*$/.exec(whole.slice(0, at));
  if (verdict) return verdict[1];
  const before = whole.slice(0, at).trim();
  let left = before.split(/[.!?:]\s/).pop().trim();
  // a wrapped line goes on with the sentence from the line above, so a word
  // or two before its dash count with the words up there: "The chmod is
  // ONE-WAY / defense; it doesn't auto-revert", never "defense, it doesn't"
  if (lineAbove && left && left === before && left.split(/\s+/).length < 2) left = `${lineAbove.split(/[.!?:]\s/).pop().trim()} ${left}`;
  if (/[.!?][*_]+$/.test(left)) return null;
  const words = left.replace(/^(?:(?:[-*+>#]|\d+[.)]|\*\*|__)\s*)+/, '').split(/\s+/);
  return words.length >= 2 && !words.every((w) => /^[A-Z][a-z0-9'\u2019-]+$/.test(w)) ? left : null;
}

// A range counts up: "10-20", or "1990-95" with the shared digits left off.
// Two numbers that count down are two things, so "line 56, 5 tabs" is never
// glued into "56-5".
function isRange(a, b) {
  return +b > +a || (a.length >= 3 && b.length < a.length && +b > +a.slice(-b.length));
}

// Who said a quote, when the words after its dash are only a name: one to
// four capitalized words, "of" or "da" between them, and maybe a period.
// It goes in parentheses after the quote, with that period outside:
// '"one person."** (Sam Altman).' A short note can follow the name after a
// comma, in parentheses, or as "via" or "on" something, and joins it:
// '(Steve Jobs, WWDC 1997)', '(Evan Wilson, same)', '(Prydz on Call on Me)'.
// A note that holds a second sentence, or a name like "Honestly, I liked
// it" that opens a sentence, is no credit. Returns null for anything else.
const CREDIT_NAME = /^((?!(?:Then|And|But|So|This|That|It|Now)\b)\p{Lu}[\p{L}\p{N}_'.-]*(?:\s+(?:of|de|da|di|der|la|le|van|von|\p{Lu}[\p{L}\p{N}_'.-]*)){0,3})(.*)$/u;
function creditAfterQuote(quote, rest) {
  const credit = CREDIT_NAME.exec(rest.trim());
  if (!credit) return null;
  let name = credit[1];
  let tail = credit[2];
  let end = '';
  if (!tail) {
    if (/\p{Ll}{2}\.$/u.test(name)) { end = '.'; name = name.slice(0, -1); }
  } else {
    const note = /^,\s+(.+)$/.exec(tail) || /^\s+\((.+)\)$/.exec(tail) || /^(\s+(?:via|on)\s.+)$/.exec(tail);
    if (!note || /[.!?;]\s|:\s/.test(note[1]) || /^(?:I|we|you|he|she|they|it|this|that|there)\b/i.test(note[1]) || /ly$/.test(name)) return null;
    let text = note[1];
    if (/[\p{L}\p{N}]\.$/u.test(text) && !/\b\p{Lu}\.$/u.test(text)) { end = '.'; text = text.slice(0, -1); }
    name += note[0].startsWith(',') || note[0].startsWith(' (') ? `, ${text}` : text;
  }
  // one word and a period is a verdict on the quote, not who said it:
  // '"Let\'s circle back.": Dead.'
  if (end && !/\s/.test(name)) return null;
  return `${quote} (${name})${end}`;
}

// A short form whose period ends no sentence: "etc.", "e.g.", "et al.",
// and the end of a company or a name, "Inc.", "Jr.". A dash after one goes on
// with the sentence instead of starting the next.
const SHORT_FORM_END = /\b(?:etc|e\.g|i\.e|vs|cf|approx|incl|et al|Inc|Ltd|Corp|Co|Jr|Sr)$/i;

// The words that start a new sentence after a dropped dash, with a capital
// on their first word when it is a plain lowercase word. Every spot that
// starts a sentence asks here, so an exception lands once. A line that opens
// in lowercase keeps its writer's lowercase. A lone letter before a hyphen is
// usually a variable in a term, "k-means", "n-gram", "x-axis", and keeps its
// lowercase too; "a-ha" and "e-mail" are plain words and still take theirs.
function sentenceStart(rest, line) {
  if (/^[^A-Za-z]*[a-z]/.test(line) || /^[b-df-z]-/.test(rest)) return rest;
  return rest.replace(/^[a-z](?=[a-z']*(?![\w\uE000]))/, (ch) => ch.toUpperCase());
}

// a label that ends its own sentence, "**Why now?**", leaves the words after
// its dropped dash to start the next one, so a lowercase first word takes its
// capital: "**Why now?** The market moved". A short form such as "Inc." ends
// no sentence, and a line that opens in lowercase keeps its writer's lowercase.
// A quoted question goes on with its sentence ('Ask "what did we miss?" then
// read the calls'), so only a bare stop or one inside bold or italics counts.
function capitalAfterLabel(label, rest, line) {
  const stop = /([.!?])[*_]*$/.exec(label);
  if (!stop) return rest;
  if (stop[1] === '.' && SHORT_FORM_END.test(label.slice(0, stop.index).replace(/^[*_]+/, ''))) return rest;
  return sentenceStart(rest, line);
}

// An arrow drawn in a line: "->", "<-", "=>", a sideways arrow sign like "\u2192", "\u21d4",
// "\u27f6" or "\u2794", or a box-drawing line or hyphen that ends in a solid or
// hollow arrowhead, "\u2500\u2500>", "\u2500\u2500\u25b6", "\u25c1\u2500\u2500", "--\u25b6", "\u25c0--". A lone play sign
// is no arrow, and neither is an up or down arrow, which marks a change:
// "costs \u2193, revenue \u2191". "<=" and ">=" compare, so they are no arrows.
const ARROW = /->|<-|=>|[\u2190\u2192\u2194\u21a6\u21d0\u21d2\u21d4\u27f5-\u27ff\u2794-\u27be]|[-\u2500-\u257f][>\u25b6\u25b7\u25b8\u25b9\u25ba]|[<\u25c0\u25c1\u25c2\u25c3\u25c4][-\u2500-\u257f]/;
const ARROW_CHAIN_DASH = new RegExp(`(?<=(?:${ARROW.source}).*)\\u2014(?=.*(?:${ARROW.source}))`, 'g');

// The line above, when this line carries on its sentence, set for each
// fixEmDash call so clauseLeft can count the words it holds.
let lineAbove = '';

function fixEmDash(s, { endsBlock = false, startsBlock = false, spans = [], above = '' } = {}) {
  lineAbove = above;
  // a dash between a file reference and the code it points at reads "is",
  // so it takes a colon even past a label colon: "`lib/a.js:12`: `runTick`",
  // which is also what the map healer reads the name from
  s = s.replace(/\uE000(\d+)\uE001[ \t]?\u2014[ \t]*(?=\uE000\d+\uE001)/g, (m, n) => (FILE_REF.test(spans[n] || '') ? `\uE000${n}\uE001: ` : m));
  // a dash touching an arrowhead is the arrow's shaft, so it turns into a
  // hyphen of the same width: "RN -> HUC", "29->29", "a <-> b", never "RN: > HUC".
  // The same goes for a dash pressed against a sideways arrow sign on either
  // side, "plan -\u2192 build", or against a triangle arrowhead on the side it
  // points from, "plan --\u25b6 build", "build \u25c0-- review", never "plan, \u25b6 build".
  // An up or down arrow marks a change, so "cost \u2014\u2193" stays prose, and
  // ">=" compares, so "x \u2014>= 3" never turns into "x ->= 3".
  // A fat arrow's shaft is drawn with equals signs, so a dash pressed against
  // "=>" lengthens it: "plan ===> build", never "plan, => build" or "--=>".
  s = s.replace(/\u2014+(?==>)/g, (m) => '='.repeat(m.length));
  s = s.replace(/\u2014+(?=>(?!=)|[\u25b6\u25b7\u25b8\u25b9\u25ba\u2190\u2192\u2194\u21a6\u21d0\u21d2\u21d4\u27f5-\u27ff\u2794-\u27be])|(?<=[<\u25c0\u25c1\u25c2\u25c3\u25c4\u2190\u2192\u2194\u21a6\u21d0\u21d2\u21d4\u27f5-\u27ff\u2794-\u27be])\u2014+/g, (m) => '-'.repeat(m.length));
  // dashes pressed together between two boxes draw the line that joins them,
  // so they turn into hyphens of the same width: "[a] --- [b]", never "[a],
  // [b]". Two pressed dashes in a sentence are still one break: "He said,".
  s = s.replace(/(?<=[\])|+][ \t]*)\u2014{2,}(?=[ \t]*[[(|+])/g, (m) => '-'.repeat(m.length));
  // a dash or a run of pressed dashes that touches a drawn corner or pipe,
  // or two runs that meet at a lone corner, is the drawn line itself: "+---+",
  // "|- a", "a --- + --- b", never "a (+) b". A plus inside a word is no corner,
  // so "C++, the language" stays prose. A box-drawing corner or line never
  // shows up in prose, so a dash pressed against one is always drawn: "\u250c---\u2510",
  // "\u2514- done", never "\u250c, \u2510". A table row is fixed cell by cell below.
  if (!/^\s*\|/.test(s)) s = s.replace(/\u2014+(?=[\u2500-\u257f])|(?<=[\u2500-\u257f])\u2014+|\u2014+(?=[+|](?![\w+]))|(?<=(?<![\w+])[+|])\u2014+|\u2014{2,}[ \t]*\+[ \t]*\u2014{2,}/g, (m) => m.replace(/\u2014/g, '-'));
  // a line indented like a code block is where a diagram lives, and so is a
  // line that opens with a box, not a link or a checkbox, at any indent or
  // after quote marks, a list marker and bold or italic marks. Any run of
  // pressed dashes there is a drawn line, between plain-word steps or opening
  // a branch: "plan --- do --- review", "  -- [b]", "1. [a] --- b",
  // "> [a] --- b", "**[a]** --- b", never "plan (do)".
  const diagramStart = /^(?: {4}|\t)|^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?[*_]{0,3}(?:\[(?![ xX]\])[^\]\n]*\](?![([\uE000])|\([^)\n]*\))/;
  if (diagramStart.test(s)) s = s.replace(/\u2014{2,}/g, (m) => '-'.repeat(m.length));
  // once such a line holds a drawn line or an arrow it is a diagram, so a
  // single dash on it is one more short link: "[a] - done -> [c]", never
  // "[a], done". A flag like "--fix" is not a drawn line.
  if (diagramStart.test(s) && /(?:^|[\s\])|+])-{2,}(?=[\s[(|+]|$)|->|<-/.test(s)) s = s.replace(/\u2014/g, '-');
  // a line that opens with a box-drawing corner or line and a dash right
  // after it is drawn from its first mark, so every dash on it is part of
  // the drawing: "\u250c -- plan -- \u2510", "\u2514 - done", never "\u250c (plan) \u2510".
  // A line that opens with an upright bar and a word is the inside of a box,
  // fixed cell by cell below, while bars before the corner only nest a branch:
  // "\u2502   \u251c - step". A tree line names a file before its dash, so
  // "\u251c\u2500\u2500 people/  one page" keeps its padded description.
  if (/^\s*(?:>\s*)*(?:[\u2502\u2503\u2506\u2507\u250a\u250b\u2551\u2575\u2577\u2579\u257b\u257d\u257f][ \t]+)*(?![\u2502\u2503\u2506\u2507\u250a\u250b\u2551\u2575\u2577\u2579\u257b\u257d\u257f])[\u2500-\u257f]+[ \t]*\u2014/.test(s)) s = s.replace(/\u2014/g, '-');
  // a line that draws an arrow is a diagram too, so a run of pressed dashes
  // on it is a drawn line of the same width: "plan --- build -> review",
  // never "plan, build". An HTML comment, or its close at the end of a line,
  // is not an arrow, but a long arrow mid-line is: "plan --> build --- review".
  if (!/^\s*\|/.test(s) && ARROW.test(s.replace(/<!--(?:(?!-->).)*(?:-->|$)|-->\s*$/g, ''))) s = s.replace(/\u2014{2,}/g, (m) => '-'.repeat(m.length));
  // a single dash with a box edge on both sides is a short link between two
  // boxes, so it takes a hyphen: "[a] - [b] - [c]", never "[a] ([b]) [c]"
  if (!/^\s*\|/.test(s)) s = s.replace(/(?<=[\])|+][ \t]*)\u2014(?=[ \t]*[[(|+])/g, '-');
  // a single dash with an arrow before it and an arrow after it sits inside
  // a chain of steps, so it takes a hyphen: "plan -> build - review -> ship",
  // never "build, review". A table row is fixed cell by cell below.
  if (!/^\s*\|/.test(s)) s = s.replace(ARROW_CHAIN_DASH, '-');
  // a table cell that holds only a dash means "nothing here"; a hyphen keeps
  // the cell instead of turning it into a stray comma
  if (/^\s*\|/.test(s)) s = s.replace(/(\|\s*)\u2014(\s*)(?=\||$)/g, '$1-$2');
  // each cell of a table row is fixed on its own, like the start of a block,
  // so no rule reads across a border: "| R3: pick customer |", and two
  // dashes in two cells never pair into "HIGH (improves all output | HIGH)"
  if (/^\s*\|.*\|/.test(s) && /\u2014/.test(s)) {
    return s.split(/((?<!\\)\|)/).map((cell, i) => (i % 2 || !/\u2014/.test(cell) ? cell
      : cell.replace(/^(\s*)([\s\S]*?)(\s*)$/, (m, lead, body, tail) => `${lead}${fixEmDash(body, { startsBlock: true })}${tail}`))).join('');
  }
  // a line inside a drawn box is fixed cell by cell the same way, and each
  // cell is padded back to its old width so the right border still lines up:
  // "\u2502 STEP 1/5: Creating middleware       \u2502", not one column short
  if (/^\s*[\u2502\u2503\u2551].*[\u2502\u2503\u2551]\s*$/.test(s) && /\u2014/.test(s)) {
    return s.split(/([\u2502\u2503\u2551])/).map((cell, i) => (i % 2 || !/\u2014/.test(cell) ? cell
      : cell.replace(/^(\s*)([\s\S]*?)(\s*)$/, (m, lead, body, tail) => {
        const fixed = fixEmDash(body, { startsBlock: true });
        const room = tail.length + body.length - fixed.length;
        return `${lead}${fixed}${' '.repeat(Math.max(room, tail ? 1 : 0))}`;
      }))).join('');
  }
  // padding before a dash lines descriptions up in a column, as in a folder
  // tree or a command list: "people/            \u2014 one page". The spaces already
  // part name from description, so the dash turns into spaces and the column
  // stays put. Two spaces after a long phrase is a typo in a sentence, not a
  // column, and a list or quote marker alone before the padding names nothing.
  s = s.replace(/(?<=\S)( {2,})\u2014 (?=\S)/g, (m, pad, at) => {
    if (/^\s*(?:[-*+>]|\d+[.)])$/.test(s.slice(0, at))) return m;
    const left = s.slice(0, at).split(/ {2,}|^\s*(?:[-*+]|\d+[.)])\s+/).pop();
    return pad.length >= 3 || left.trim().split(/\s+/).length <= 3 ? `${pad}  ` : m;
  });
  s = s.replace(TIMED_HEADING_DASH, '$1 - $2');
  // a dash before "(a)", "(1)" or "(i)" opens a run of lettered or numbered
  // items, so it takes a colon like any list: "caught 2 issues: (a) the
  // floor was too weak, (b) one seed", never "issues, (a)". A second dash
  // in the sentence closes an aside instead: "pick one, (a) or (b), then go"
  s = s.replace(/(?<=[\w)\]"'*_`%\u201d\u2019\uE001])[ \t]*\u2014[ \t]*(?=\((?:a|1|i)\)\s)(?![^\u2014.!?]*\u2014)/g, ': ');
  // a dash just inside an opening italic or bold mark mid-line moves out of
  // the mark, so the rules below read it as any other dash: "Ship it, *now*",
  // never "Ship it *, now*".
  s = s.replace(/(?<=\S)[ \t]+(\*{1,2}|_{1,2})\u2014[ \t]*(?=\w)/g, ' \u2014 $1');
  // the same goes for one just inside a closing mark: "Ship it *now*, then
  // rest", never "*now, * then rest".
  s = s.replace(/(?<=\w)[ \t]+\u2014(\*{1,2}|_{1,2})(?=[ \t.,;:!?)]|$)/g, '$1 \u2014');
  // a dash between two numbers is a range, "10-20", unless the first has a
  // sign, which makes it a score: "reward: +4, 404 on missing routes"
  // A dash that opens a line, a quote or a list item names nothing and goes,
  // and so does one just inside an opening italic or bold mark, which keeps
  // the mark: "*an agent who tried it*", never "*, an agent".
  s = s.replace(/\u2014(?:\s*\u2014)+/g, '\u2014').replace(/(?<![+-]\d*)(\d+)\s*\u2014\s*(?=(\d+)(?![\d-]))/g, (m, a, b) => (isRange(a, b) ? `${a}-` : m)).replace(/^(\s*(?:>\s*)*)(?:([-*+]|\d+\.)\s+)?(\*{1,2}|_{1,2})?\u2014\s*/, (m, lead, marker, mark = '') => (marker ? lead + marker + ' ' : lead) + mark);
  s = s.replace(LESSON_DASH, (m, head, verdict) => `${head} - ${verdict ? `${verdict} - ` : ''}`)
    .replace(/^(\s*[-*]\s+\*\*\[[^\]]+\][^*]+\*\* - [a-z][\w-]*:\s.*)$/, (line) => line.replace(/\s*\u2014\s*(?=[a-z][\w-]*:\s)/g, ' - '));
  s = s.replace(NAME_ADDRESS_DASH, '$1$2, ');
  const greeting = GREETING_DASH.exec(s);
  if (greeting) {
    const rest = s.slice(greeting[0].length);
    return `${greeting[1].replace(/,$/, '')},${rest ? ` ${fixEmDash(rest, { endsBlock })}` : ''}`;
  }
  if (endsBlock) s = s.replace(/([.,;:!?]?)\s*\u2014\s*$/, (m, p) => p || '.');
  // a bold sentence that is the whole line or the whole list item goes on
  // past a dash before "through", "via" or "with", which only says how, so
  // the dash takes a comma: "**Add each step as a task, through the task
  // db.**", never a colon that reads as a title and a subtitle
  s = s.replace(/^(\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*|__)[^\u2014*_]*[^\s\u2014,;:*_])\s*\u2014\s*(?=(?:through|via|with)\b[^\u2014*_]*(?:\*\*|__)\s*$)/i, '$1, ');
  // a dash inside an open parenthesis splits no title from a subtitle, so a
  // heading fixes it like a bold one: "### AI Clients (`backend/clients/`,
  // 32 files)", never "(`backend/clients/`: 32 files)"
  const heading =[HEADING_DASH, BOLD_HEADING_DASH].find((re) => re.test(s) && !insideParens(re.exec(s)[1]));
  if (heading) {
    const m = heading.exec(s);
    return `${m[1]}: ${fixEmDash(s.slice(m[0].length), { endsBlock })}`;
  }
  let label = LIST_LABEL_DASH.exec(s) || LINE_LABEL_DASH.exec(s) || NUMBERED_LABEL_DASH.exec(s);
  // a plain-word label whose dash opens an aside closed by a second dash in
  // the same sentence is a subject, not a label: "Retries (up to 3) happen
  // automatically", never "Retries: up to 3, happen". Marked and code labels stay.
  // An even count of dashes after the label pair among themselves, so the
  // label keeps its colon: "Inbox Triage: 23 emails (all read) processed".
  // A next dash before a joining word goes on with the sentence instead of
  // closing an aside, so the label stays: "1. Setup: install it, then run it".
  // A bold field label that holds its own colon, then four plain words or
  // more, may open a sentence whose aside pairs: "- **Framework:** Applied
  // three laws (visualize, outwork) across sports", never "three laws:
  // visualize, outwork, across". That reading is kept only when it gives
  // parentheses; fewer words name a sub-label ("**Next tick:** tick 31: ship
  // it"), and a second bold title, "**T2:** **Ship docs**", is a label too.
  // A short subject still pairs when a helping verb follows the aside, so the
  // sentence runs on through it: "**Gap closed:** the deck (what a customer
  // sees) is now current", never "the deck: what a customer sees, is now".
  const fieldThenWords = label && /^((?:\*\*[^*]+:\*\*|__[^_]+:__)\s+)([^*_`\uE000()]*[^\s*_`\uE001()])$/.exec(label[2]);
  if (fieldThenWords) {
    const body = fieldThenWords[2] + s.slice(label[1].length + label[2].length);
    const alt = fixEmDash(body, { endsBlock });
    const paired = (alt.match(/\(/g) || []).length > (body.match(/\(/g) || []).length;
    const runsOn = alt.startsWith(`${fieldThenWords[2]} (`) && (alt.match(ASIDE_THEN_HELPER) || []).length > (body.match(ASIDE_THEN_HELPER) || []).length;
    if (paired && (runsOn || fieldThenWords[2].trim().split(/\s+/).length >= 4)) return `${label[1]}${fieldThenWords[1]}${alt}`;
  }
  const restSentence = label && s.slice(label[0].length).split(/[.!?]["'\u201d\u2019)]*\s/)[0];
  if (label && !/^(?:\*|_|`|\uE000|"|\u201c)/.test(label[2])
    && (restSentence.match(/\u2014/g) || []).length % 2
    && !/^[^\u2014]*\u2014\s*(?:and|but|or|nor|so|yet|then)\b/i.test(restSentence)) label = null;
  // a label that already ends in its own punctuation, "**what is it?**",
  // keeps it and just loses the dash, so no colon stacks on top. A label that
  // is one whole quote is a phrase being explained, so its colon goes after
  // the closing quote: '- "What did we miss?": summarizes calls'.
  const quoted = label && /^(?:"[^"]*"|\u201c[^\u201c\u201d]*\u201d)$/.test(label[2]);
  // A code or bold label after a comma in the same line opens a second field
  // of the same kind, so it takes a colon too: "`floor`: line 21,
  // `isConfident`: line 22", never "`isConfident`, line 22".
  let rest = label && s.slice(label[0].length);
  if (label && /^(?:`[^`]+`|\ue000\d+\ue001|\*\*[^*]+\*\*)$/.test(label[2])) {
    rest = rest.replace(/([,;]\s+)(`[^`]+`|\ue000\d+\ue001|\*\*[^*\u2014]+\*\*)\s*\u2014\s*(?=\S)(?!(?:and|but|or|nor|so|yet|then)\b)/g, '$1$2: ');
  }
  // a quote that leads the line and ends its own sentence, then a name, is
  // a credit, not a label: '> *"Power is the limit."* (Musk)'
  const credit = label && /[.!?]["'\u201d\u2019*_]*["'\u201d\u2019][*_]*$/.test(label[2]) && creditAfterQuote(label[1] + label[2], rest);
  if (credit) return credit;
  // a list item that already holds its field colon, "pass: you call it when
  // a beat holds up", is no label. A full clause after its dash joins the
  // value the way the clause rules join it mid-line: "...holds up; the AI
  // never calls it". A list or an explanation after it keeps the colon.
  const field = label && /^[A-Za-z][\w #()-]{0,29}:\s+(\S.*)$/.exec(label[2]);
  if (field && fixEmDash(`${field[1]} \u2014 ${rest}`).startsWith(`${field[1]}; `)) return `${label[1]}${label[2]}; ${fixEmDash(rest, { endsBlock })}`;
  if (label) return `${label[1]}${label[2]}${!quoted && /[.,;:!?][*_`"'\u201d\u2019]*$/.test(label[2]) ? '' : ':'}${s.length > label[0].length ? ' ' : ''}${fixEmDash(capitalAfterLabel(label[2], rest, s), { endsBlock })}`;
  const term = startsBlock && (TERM_DASH.exec(s) || TITLE_DASH.exec(s));
  if (term) return `${term[1]}: ${fixEmDash(s.slice(term[0].length), { endsBlock })}`;
  // in a sentence with an odd run of three or more dashes, one before a
  // joining word only continues the sentence, so it takes its comma first and
  // the rest pair: "It works, and the gate (the strict one) still holds".
  s = s.split(/([.!?]["'\u201d\u2019)]*\s)/).map((part, i) => {
    const run = (part.match(/\u2014/g) || []).length;
    return i % 2 || run < 3 || run % 2 === 0 ? part : part.replace(/\s*\u2014\s*(?=(?:and|but|or|nor|so|yet)\b)/g, ', ');
  }).join('');
  return s
    // a quote that opens a block or a list item, alone or after a bold label,
    // names a term or a question, so the words after its dash explain it and
    // take a colon: '"Where does the byte stop?": traces the path first'. A
    // quote on a wrapped line is mid-sentence ('its button said / "Find
    // people", now one voice'), and a quote that ends its own sentence, or
    // speech that goes on with "and" or "she said", keeps its other fixes.
    .replace(/^(\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\*\*[^*]+:\*\*\s+)?)("[^"]*[^".]"|\u201c[^\u201c\u201d]*[^\u201d.]\u201d)\s*\u2014\s*(?=[^\s\u2014])(?!(?:and|but|or|nor|so|yet|then|he|she|they|I|we|you)\b)/, (m, lead, quote) => (startsBlock || /^\s*(?:[-*+]|\d+[.)])\s/.test(lead) ? `${lead}${quote}: ` : m))
    // a bold phrase that opens a sentence partway through the line is a label
    // too: "etc. **Include eliminate steps**: what gets deleted". One that ends
    // in its own punctuation, "**What now?**", keeps it and just loses the dash.
    // A bold quote that ends its sentence and then a name is a credit, left
    // for the credit rule below: '1. **"just a fun thing."** (Prydz)'. One
    // before a joining word goes on with its sentence, like a short list
    // label: "5. **Open source is catching up**, and that's great".
    .replace(/([.!?]["'\u201d\u2019)]*\s+)(\*\*[^*\u2014]*[^\s*\u2014]\*\*|__[^_\u2014]*[^\s_\u2014]__)\s*\u2014\s*(?=\S)([a-z])?/g, (m, lead, bold, ch = '', at, whole) => {
      const rest = ch + whole.slice(at + m.length);
      if (/^(?:and|but|or|nor|so|yet)\b/.test(rest)) return m;
      if (/[.!?]["'\u201d\u2019]+[*_]+$/.test(bold) && !/\u2014/.test(rest) && creditAfterQuote(bold, rest)) return m;
      return `${lead}${bold}${/[.,;:!?][*_]+$/.test(bold) ? '' : ':'} ${ch && capitalAfterLabel(bold, rest, whole).charAt(0)}`;
    })
    // an aside never crosses a sentence end; dashes split by one are fixed alone.
    // An aside already inside parentheses, or holding its own, takes commas,
    // so none nest: "then (maybe) stop" never becomes "(then (maybe) stop)".
    .replace(/\s*\u2014\s*((?:(?![.!?]["'\u201d\u2019)]*\s)[^\u2014])*[^\s\u2014])\s*\u2014\s*(?=(.?))/g, (m, aside, next, at, whole) => {
      const gap = next && !/[.,;:!?)\]]/.test(next);
      // an odd run of three or more dashes in one sentence has no clear pairs,
      // so each is fixed alone: "A, b, c, d", never "A (b) c, d".
      const stop = /[.!?]["'\u201d\u2019)]*\s/g;
      const from = Math.max(0, ...[...whole.slice(0, at).matchAll(stop)].map((e) => e.index + e[0].length));
      const to = whole.slice(at).search(stop);
      const sentence = whole.slice(from, to < 0 ? whole.length : at + to);
      const run = (sentence.match(/\u2014/g) || []).length;
      if (run >= 3 && run % 2) return m;
      // A run where each dash opens a "label: value" field is a list of
      // fields, so each is fixed alone: "shipped: 1/1, halt: 0%, reward: 0",
      // never "shipped: 1/1 (halt: 0%) reward: 0".
      if (sentence.split('\u2014').slice(1).every((part) => /^\s*[\w-]+(?: [\w-]+)?:\s/.test(part))) return m;
      // an aside that holds one side of a quote crosses the quote's edge, so
      // each dash is fixed alone: 'said "go, now", and left', never '"go (now")'.
      const count = (re) => (aside.match(re) || []).length;
      if (count(/"/g) % 2 || count(/\u201c/g) !== count(/\u201d/g)) return m;
      // So does one that holds one side of a bold or code mark: "**SFH-16:
      // insider guide library.** The old one was fake", never "(insider ...**".
      if (count(/\*\*/g) % 2 || count(/__/g) % 2 || count(/`/g) % 2) return m;
      // An aside that opens with a joining word goes on with the sentence, so
      // it takes commas too: "install it, then run it, and ship". Punctuation
      // already before it keeps its place: 'said "stop." then it went, and left'.
      // A lone joining word takes no comma after it: "Ship it, then wait."
      // "So" joins only before its subject ("so it ships"), and "yet" not
      // before "another", so "the fix (so small it fits) shipped" stays an aside.
      const holdsParens = /[()]/.test(aside) && !wrappedInParens(aside);
      if (/^(?:and|but|or|nor|then)\b|^so(?:$|\s+(?:it|we|they|you|I|he|she|the|a|an|this|that|these|those|there|nothing|everything)\b)|^yet\b(?!\s+(?:another|again|more)\b)/.test(aside)) {
        return `${/[.,;:!?]["'\u201d\u2019)]*$/.test(whole.slice(0, at)) ? ' ' : ', '}${aside}${!gap ? '' : /^\w+$/.test(aside) ? ' ' : ', '}`;
      }
      // Dashes pressed inside a bracket only doubled it, so both just go:
      // "Ship it (maybe) now", never "(, maybe)".
      if (/[([]$/.test(whole.slice(0, at))) return `${aside}${gap ? ', ' : ''}`;
      // A colon or comma the writer already put before the dash stays, so no
      // comma stacks on it: '"T35b: DONE (navigator), Name it"', never "T35b:,".
      // One emphasized word alone is stress, not an aside, so it takes commas
      // too: "We ship, *fast*, every day", never "We ship (*fast*) every day".
      // So is a lone word that only says how often or how sure: "The gate,
      // always, blocks it". A lone name keeps its brackets: "the tool (Redis)".
      // A short stock phrase is the same: "It works, of course, on day one",
      // and so is a lone word that links back to the sentence before: "Ship
      // it, however, when green".
      const stressed = /^(\*{1,2}|_{1,2})[\w'-]+\1$/.test(aside)
        || /^(?:always|never|often|still|again|sometimes|usually|rarely|seldom|maybe|perhaps|probably|certainly|surely|honestly|finally|eventually)$/i.test(aside)
        || /^(?:however|though|instead|therefore|also|too|thus|meanwhile|otherwise|besides|anyway|nonetheless|nevertheless)$/i.test(aside)
        || /^(?:of course|for now|at least|at most|at best|at worst|at first|in fact|in short|in theory|in practice|for sure|so far|by far|after all|above all|as usual|once again)$/i.test(aside);
      if (holdsParens || stressed || insideParens(whole.slice(0, at))) return `${/[,;:]$/.test(whole.slice(0, at)) ? ' ' : ', '}${aside}${gap ? ', ' : ''}`;
      // the closing dash also stood in for the comma before a "which" remark:
      // "scale (model size, data), which is a bet", never "data) which is".
      const after = whole.slice(at + m.length);
      // So did it for the comma that ends an opening "if" or "when" clause
      // when the main clause starts right after: "if the cluster is big
      // enough (like continent-sized), that thing could be powerful". A
      // "then" there opens the main clause too: "if the ideas turn out right
      // (the ones we discussed), then we have something".
      const opening = /\b(?:if|when|whenever|unless|until|because|although|though|any time|every time)\b[^,;:()]*$/i.test(whole.slice(from, at))
        && /^(?:it|we|they|you|I|he|she|there|that thing|this thing|then)(?:['\u2019](?:s|re|ll|ve|d|m))?\s/.test(after);
      const remark = /^(?:which|although|whereas)\b/.test(after);
      return ` ${wrappedInParens(aside) ? aside : `(${aside})`}${remark || (gap && opening) ? ', ' : gap ? ' ' : ''}`;
    })
    // a name that closes the line after a quote with its own stop is who said
    // it, so it goes in parentheses: 'backward." (Steve Jobs)', never a bare
    // name that reads as a fragment or a stacked '.",'. Bold or italics around
    // the quote close it the same way, '*"power."* (Musk)', and a period after
    // the name stays outside: '"one person."** (Sam Altman).'
    .replace(/([.!?]["'\u201d\u2019*_]*["'\u201d\u2019][*_]*)\s*\u2014\s*([^\u2014]+)$/, (m, stop, rest) => creditAfterQuote(stop, rest) || m)
    // a lowercase word after a quote that ends its sentence starts the next
    // one, so the dash goes and the word takes its capital: 'automatically."
    // Transactions stay unfinished'. A joining word goes on with the sentence,
    // 'The start." which is more shareable', and a line that opens in
    // lowercase keeps its writer's lowercase.
    .replace(/(\.["'\u201d\u2019]+)\s*\u2014\s*(?!(?:which|who|whose|and|but|or|nor|so|yet|then|because|since|while|where|when|though|although|as|if|unless|until|than)\b)([a-z])(?=[a-z']*(?![\w\uE000]))/g, (m, stop, ch, at, whole) => {
      const word = sentenceStart(whole.slice(at + m.length - 1), whole).charAt(0);
      return word === ch ? m : `${stop} ${word}`;
    })
    // any other leftover dash after a quote that already ends its sentence
    // goes, and the quote keeps its own stop: 'wiring." PERSONA.md exists'.
    // A quoted question before a lowercase word goes on with its sentence.
    .replace(/(\.["'\u201d\u2019]+|[!?]["'\u201d\u2019]+(?=\s*\u2014\s*[A-Z]))\s*\u2014\s*(?=\S)/g, '$1 ')
    // a dash that opens a list of three or more short items running to the
    // end of the sentence introduces it: "sweep: arxiv, github, web."
    // a field whose value is one verdict word keeps the comma instead
    .replace(LIST_AFTER_DASH, (m, close, at, whole) => (close && !insideParens(whole.slice(0, at)) || VERDICT_FIELD.test(whole.slice(0, at)) ? m : ': '))
    .replace(ING_LIST_AFTER_DASH, (m, at, whole) => (VERDICT_FIELD.test(whole.slice(0, at)) ? m : ': '))
    // a dash between two full clauses joins them; a comma there is a splice
    // ("this isn't optional, it's part of design"), so it takes a semicolon.
    // The left side needs two words of its own sentence to be a clause, so
    // an opener like "Then" keeps its comma.
    // a list that is the whole sentence so far, then "these" or "those",
    // is summed up by the words after it, so the dash points back with a
    // colon: 'purple gradients, instrument serif, "claude beige": these are
    // gravity wells', never a semicolon after words that are no clause
    .replace(CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      if (!left) return m;
      if (/^(?:these|those)\b/i.test(whole.slice(at + m.length)) && BARE_LIST.test(left.replace(/^(?:[-*+>]|\d+[.)])\s+/, ''))) return ': ';
      return clauseJoin(left);
    })
    .replace(QUANTITY_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(PAST_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(NOUN_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(AND_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(ONLY_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(STATUS_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(PLAIN_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      if (!left || NAME_BEFORE_PLAIN_VERB.test(whole.slice(at))) return m;
      return /\b(?:not|cannot)\b/i.test(left) || PLAIN_OBJECT_CLAUSE.test(whole.slice(at)) ? clauseJoin(left) : m;
    })
    .replace(ADVERB_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    // three words or fewer after a semicolon name a thing with no verb of
    // their own, so "6 defects; the big one, audit rows carry" stays
    .replace(PLURAL_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left && !(/;\s/.test(left) && left.split(/;\s/).pop().split(/\s+/).length <= 3) ? clauseJoin(left) : m;
    })
    .replace(THE_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left && !NAME_BEFORE_PLAIN_VERB.test(whole.slice(at)) ? clauseJoin(left) : m;
    })
    .replace(THAT_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(END_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(EACH_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(BARE_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(BARE_VERB_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(POSSESSIVE_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    .replace(QUESTION_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      if (!left) return m;
      const opener = left.replace(/^.*?\*\*[^*]*:\*\*\s*/, '').replace(/^[^A-Za-z]+/, '');
      if (/^(?:if|when|whenever|once|unless|until|after|before|while|because|since|as|although|though|with|given|for)\b/i.test(opener)
        && opener.split(/,\s+/).slice(1).every((part) => /^[A-Z](?![\s'\u2019])/.test(part))) return m;
      return /\b(?:ask|asking|wonder|wondering|curious)$/i.test(left) ? ': ' : clauseJoin(left);
    })
    .replace(LEADING_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      return left ? clauseJoin(left) : m;
    })
    // one word in an open bracket, "(IMPORTANT, use this)", or a quoted
    // title, '"AI Engine Optimization, write content"', is no clause. Two
    // words name a thing, so the order explains it and takes a colon:
    // "progressive disclosure: start simple, reveal complexity". A bold label
    // before them is not counted, and an indented line that carries on a
    // wrapped sentence is no name, so it keeps its semicolon.
    .replace(ORDER_CLAUSE_AFTER_DASH, (m, at, whole) => {
      const left = clauseLeft(at, whole);
      if (!left) return m;
      const inner = left.split('(').pop();
      const words = (left.includes('(') && !inner.includes(')') ? inner : left).replace(/^[\s"'*_]+/, '').split(/\s+/);
      if (words.length < 2 || words.every((w) => /^[A-Z][A-Za-z0-9'-]*$/.test(w))) return m;
      const leftOrder = new RegExp(`^${ORDER_VERB}\\s`, 'i');
      // A semicolon already closed an earlier clause, so only the one after
      // it sits beside the order: "run it first; if it passes, the task is
      // done; halt and write why", never "done, halt".
      const near = left.split(/;\s/).pop();
      const quoted = near.split(/["\u201c]/).pop();
      if ([near, quoted].some((part) => leftOrder.test(part.replace(/^(?:(?:\*\*[^*]+\*\*:?|[-*+>]|\d+[.)]|[\s'_])\s*)+/, '')))) return m;
      // a code comment's own "//" is no word, so "// Hard deadline" names a
      // thing too: "// Hard deadline: kill the request". A comment that opens
      // in lowercase may carry on the line above, so it keeps its semicolon.
      // Two words just inside an open parenthesis name a thing the same way:
      // "Progressive disclosure (the idea: start simple)", never "(the idea;".
      const body = left.replace(/^(?:\*\*[^*]+:\*\*\s*)/, '').replace(/^\/\/+\s*(?=[A-Z])/, '');
      const named = (insideParens(left) ? words : body.split(/\s+/)).length === 2;
      // a bold phrase that closes the clause names the idea, and the order
      // spells it out: "AI is best used to **raise the floor**: automate the
      // mechanical 80%", never a semicolon that cuts the two apart
      if (/\S\s+(?:\*\*[^*]+\*\*|__[^_]+__)$/.test(left)) return ': ';
      return named && !/^\s+[a-z]/.test(whole) ? ': ' : clauseJoin(left);
    })
    // a stop right before the dash ended the sentence, so the lowercase word
    // after it starts the next one: "why bother? Nobody reads it", never
    // "why bother? nobody". A short form like "etc." ends no sentence, so it
    // goes on with a comma: "etc., the gate holds". An ellipsis trails off
    // on purpose and keeps its lowercase, and so does a line that opens in
    // lowercase, since its writer starts sentences that way. A stop inside
    // closing bold or italics ends the sentence the same way: "**Why now?**
    // The market moved".
    .replace(/(^|[^.])([.!?])(\*{1,2}|_{1,2})?\s*\u2014\s*([a-z])(?=[a-z']*(?![\w\uE000]))/g, (m, lead, stop, mark = '', ch, at, whole) => {
      if (stop === '.' && SHORT_FORM_END.test(whole.slice(0, at) + lead)) return `${lead}.${mark}, ${ch}`;
      return `${lead}${stop}${mark} ${sentenceStart(whole.slice(at + m.length - 1), whole).charAt(0)}`;
    })
    // a short tail after a list of three or more items that runs from the
    // start of its sentence is a note on the whole list, so it goes in
    // parentheses: "site, X, blog, GitHub (weekly)", never "GitHub, weekly",
    // which reads as one more item. A list already in parentheses keeps its
    // comma. A list of what it is not leads to what it is, so that takes a
    // colon: "Not sends, not laps, not meetings: replies".
    .replace(LIST_TAIL_DASH, (m, tail, at, whole) => {
      const left = whole.slice(0, at).split(/[.!?:]\s/).pop().replace(/^\s*(?:(?:[-*+>]|\d+[.)])\s+)*/, '').trim();
      if (!BARE_LIST.test(left) || insideParens(whole.slice(0, at))) return m;
      return /^(?:not|no|never)\b/i.test(left) ? `: ${tail}` : ` (${tail})`;
    })
    // an article after a dash mid-sentence only took its capital because the
    // dash looked like a fresh start, so after the comma it goes lowercase:
    // "[VISION.md](VISION.md), the AtrisOS philosophy", never ", The AtrisOS".
    // A title keeps its capitals: "Star Wars, The Empire Strikes Back".
    .replace(/(\s*\u2014\s*)(The|An?)(?= )/g, (m, dash, article, at, whole) => {
      if (/(?:^|[.!?]["'\u201d\u2019)*_]*)\s*$/.test(whole.slice(0, at))) return m;
      const phrase = whole.slice(at + m.length).split(/[.,;:!?()\[\]\u2014]/)[0];
      const prose = phrase.split(/\s+/).some((w) => /^[a-z]/.test(w) && !TITLE_SMALL_WORD.test(w));
      return prose ? `${dash}${article.toLowerCase()}` : m;
    })
    // keep punctuation the writer already put beside the dash instead of
    // stacking a comma on it, and never leave a trailing space. A dash pressed
    // against a closing quote or bracket takes its comma with no space after.
    // A quote that ends in a question or a shout already does a comma's job,
    // so none is stacked on it when the sentence plainly goes on: a joining
    // word, a short lead-in to a colon, or one closing word ('no longer
    // "what would you like?" it\'s:'). A new clause there keeps its comma,
    // since without one 'ask "anything else?" bring up the bid' runs on.
    // The period of a short form ends no sentence, so a comma joins it too:
    // "Cooling, Inc., Columbus, OH", "Yang et al., 61 citations".
    .replace(/([,;:.!?]?)\s*\u2014(\s*)([,;:.!?]?)\s*(?=(.?))/g, (m, before, gap, after, next, at, whole) => {
      const closes = /[\u201d\u2019]/.test(next) || (!gap && !after && /["')\]]/.test(next));
      const rest = whole.slice(at + m.length);
      const asked = !before && !after && /[!?]["'\u201d\u2019]+\s*$/.test(whole.slice(0, at))
        && (/^(?:and|or|but|nor|if|vs\.?|versus|not|with|without|is|are|was|were|becomes|became|answered|matches)\b/.test(rest)
          || /^[^.!?;:]{0,30}:\s*$/.test(rest) || /^[\w-]+[.!?]?\s*$/.test(rest));
      const short = before === '.' && !after && SHORT_FORM_END.test(whole.slice(0, at));
      return `${short ? '.,' : before || after || (asked ? '' : ',')}${next && !closes ? ' ' : ''}`;
    });
}

// Code in markdown is literal: a dash in `inline code` or a fenced block is
// part of a command or example, not prose. Rules marked proseOnly skip fenced
// lines and see inline code masked out, and the fixer puts the code back.
const MARKDOWN = /\.mdx?$/i;

// In a script only comments are prose. A dash in a string or pattern is
// program text, so changing it changes what the code or its test checks:
// "includes an em dash" would quietly become "includes a comma". Returns
// where this line's comment starts (0 when the whole line is comment), or -1
// when there is none. State carries open block comments and template strings.
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;

function commentStart(line, state) {
  let i = 0;
  if (state.block) {
    const end = line.indexOf('*/');
    if (end === -1) return 0;
    state.block = false;
    if (!line.slice(end + 2).trim()) return 0;
    i = end + 2;
  }
  let quote = state.template ? '`' : null;
  state.template = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return i;
    else if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) { state.block = true; return i; }
      i = end + 1;
    } else if (c === '/' && opensPattern(line, i)) i = patternEnd(line, i);
  }
  if (quote === '`') state.template = true;
  return -1;
}

// A slash opens a pattern, not a division, when what comes before it cannot
// end a value: line start, an operator or opening bracket, or a word like
// return. Inside the pattern a slash such as the two in https?:\/\/ is not a
// comment, so the scan has to step over the whole pattern.
function opensPattern(line, at) {
  const before = line.slice(0, at).trimEnd();
  if (!before) return true;
  if (/[(,=:[!&|?{};+\-*%~^<>]$/.test(before)) return true;
  return /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|yield|await)$/.test(before);
}

// Index of the slash that closes the pattern opened at `at`. A slash inside a
// character class or after a backslash does not close it. With no closing
// slash on the line it was not a pattern, so the scan resumes after it.
function patternEnd(line, at) {
  let cls = false;
  for (let j = at + 1; j < line.length; j++) {
    const c = line[j];
    if (c === '\\') j++;
    else if (c === '[') cls = true;
    else if (c === ']') cls = false;
    else if (c === '/' && !cls) return j;
  }
  return at;
}

function fencedLines(lines) {
  const fenced = new Set();
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    // a block closes only on a fence at least as long as the one that opened
    // it, so a four-backtick example that shows a three-backtick block inside
    // stays code to its end
    if (m && (!fence || (m[1][0] === fence[0] && m[1].length >= fence.length))) { fence = fence ? null : m[1]; fenced.add(i); continue; }
    if (fence) fenced.add(i);
  }
  return fenced;
}

// Inline code, a link or image address, and an HTML tag are all literal: a
// dash there is part of a path or attribute, and pairing it with a prose dash
// would drop a parenthesis into the address. So are a footnote label, a
// reference label after link text, and the label and address that open a
// reference definition; the title and note text after them stay prose. So
// is the text inside a code-like HTML pair (<kbd>, <code>, <samp>, <var>,
// <tt>) and inline math; a math span opens on a non-space and closes on a
// non-space with no digit after, so "$5 and $10" stays prose. A link address
// may hold one level of parentheses, like a wiki page ending in "_(film)",
// and its quoted title is masked with it, like an HTML title attribute.
// A dash alone in brackets or quotes names the mark instead of using it,
// "no em dashes (\u2014) unless", so it is masked too and never turns into "(: )".
// A template placeholder in angle brackets is prose, not a tag: one that
// opens on a letter, holds a spaced dash and no "=" or quote, like
// "<one line \u2014 what this member does>", stays open to the scan and the fix.
// Each is masked while the fix runs.
const LITERAL_SPAN = /(`+).+?\1|(?<=[(\["'\u201c\u2018])\u2014(?=[)\]"'\u201d\u2019])|<(kbd|code|samp|var|tt)\b[^<>]*>.*?<\/\2\s*>|\$\$.+?\$\$|\$(?=\S)[^$]+?(?<=\S)\$(?!\d)|\[\^[^\]\s]+\]|^\s{0,3}\[[^\]]+\]:\s*\S+|(?<=\])\[[^\]]+\]|(?<=\])\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)?|<(?![A-Za-z][^<>="']*\s\u2014\s)[A-Za-z/!][^<>]*>/g;
const FILE_REF = /^(`+)[^`\s]+\.\w{1,5}:\d+(?:-\d+)?\1$/;
function maskInlineCode(line) {
  const spans = [];
  const masked = line.replace(LITERAL_SPAN, (m) => `\uE000${spans.push(m) - 1}\uE001`);
  return { masked, spans, restore: (s) => s.replace(/\uE000(\d+)\uE001/g, (m, n) => spans[n]) };
}

// Each rule is deterministic: a regex + a one-line why. severity drives the icon.
// Kept high-precision on purpose, a noisy gate gets muted, and a muted gate is dead.
const RULES = [
  { id: 'ai-gradient-text', sev: 'error',
    re: /(text-transparent[^"'`]{0,40}bg-clip-text|bg-clip-text[^"'`]{0,40}text-transparent|-webkit-text-fill-color:\s*transparent|background-clip:\s*text)/i,
    why: 'gradient-filled text headline: the #1 generated-look tell' },
  { id: 'ai-purple-gradient', sev: 'error',
    re: /((from|via|to)-(purple|violet|indigo|fuchsia)-\d{2,3}\b|linear-gradient\([^)]*(#6366f1|#8b5cf6|#a855f7|#7c3aed|#4f46e5|\bpurple\b|\bviolet\b|\bindigo\b))/i,
    why: 'purple/indigo gradient: default "AI startup" palette' },
  { id: 'rainbow-gradient', sev: 'warn',
    re: /\bfrom-([a-z]+)-(?:[3-6]00)\b[^"'`]{0,60}\bto-(?!\1-)([a-z]+)-(?:[3-6]00)\b/i,
    why: 'saturated two-color gradient fill across different hues (pink to orange, blue to cyan): the rainbow CTA reflex; use one solid brand color' },
  { id: 'ai-indigo-brand', sev: 'warn',
    re: /(#6366f1|#4f46e5|#4338ca|(?:bg|text|border|from|to|ring)-indigo-(?:500|600|700)\b)/i,
    why: 'canonical AI indigo used as brand color' },
  { id: 'glassmorphism', sev: 'warn',
    re: /(backdrop-blur(?:-\w+)?\b|backdrop-filter:\s*blur)/i,
    why: 'glassmorphism (frosted blur): overused default' },
  { id: 'over-rounding', sev: 'warn',
    re: /(rounded-(?:3xl|\[(?:[2-9]\d?|1\d\d)(?:px|rem)\])|border-radius:\s*(?:2[4-9]|[3-9]\d|\d{3})px|border-radius:\s*(?:[2-9](?:\.\d+)?)rem)/i,
    why: 'over-rounded corners (>=24px / rounded-3xl)' },
  { id: 'mega-shadow', sev: 'warn',
    re: /(shadow-2xl\b|box-shadow:\s*0\s+\d{2,}px)/i,
    why: 'oversized generic drop shadow (depth-by-blur)' },
  { id: 'colored-glow-shadow', sev: 'warn',
    re: /\bshadow-(?:indigo|violet|purple|fuchsia|blue|sky|cyan|pink|rose|emerald|green|teal)-(?:400|500|600)(?:\/\d{1,3})?\b/i,
    why: 'colored glowing drop shadow under a button (shadow-<hue>-500): the neon-glow AI reflex; keep shadows soft and neutral' },
  { id: 'side-stripe-card', sev: 'warn',
    re: /border-(?:left|l)-(?:4|8|\[\d+px\])\b|border-left:\s*[3-9]px\s+solid/i,
    why: 'accent side-stripe on a card: generated layout reflex' },
  { id: 'transition-all', sev: 'warn',
    re: /\btransition-all\b|transition:\s*all\b/i,
    why: 'transition-all: animate-everything laziness, not intent' },
  { id: 'pulse-animation', sev: 'warn',
    re: /animation:[^;]*\binfinite\b|@keyframes\s+(pulse|ping|blink|glow|throb)\b|\banimate-(pulse|ping|bounce)\b/i,
    why: 'looping pulse/ping/glow animation: distracting live-status reflex' },
  { id: 'hover-lift', sev: 'warn',
    re: /\bhover:(?:-translate-y-(?:0\.5|[1-9]\d?)|scale-1(?:1[0-9]|[2-9]\d))\b/,
    why: 'card lifts/over-grows on hover (translate-y shift or scale past 1.05): the generated-card reflex; keep hover scale subtle and never shift content' },
  { id: 'decorative-blur-blob', sev: 'warn',
    re: /\bblur-3xl\b|filter:\s*blur\(\s*(?:6[4-9]|[7-9]\d|\d{3,})px\)/i,
    why: 'giant blurred gradient orb behind the hero (blur-3xl / 64px+ blur): the AI aurora-blob background reflex' },
  { id: 'noise-grain-overlay', sev: 'warn',
    re: /\bfeTurbulence\b|\bfractalNoise\b/i,
    why: 'svg turbulence-noise used as a decorative grain/film texture overlay: the generated-look grain reflex' },
  { id: 'dark-hero-gradient', sev: 'warn',
    re: /\b(?:from|via)-(?:slate|gray|zinc|neutral|stone)-9(?:00|50)\b[^"'`]{0,80}\bto-(?:black|(?:slate|gray|zinc|neutral|stone)-950)\b/i,
    why: 'near-black slate/gray hero gradient fading to black: the dark premium SaaS template look' },
  { id: 'eyebrow-caps', sev: 'warn',
    re: /text-transform:\s*uppercase\b|\buppercase\b[^"'`]{0,30}tracking-|tracking-[^"'`]{0,30}\buppercase\b/i,
    why: 'tracked all-caps eyebrow/label: dated reflex; use sentence case' },
  { id: 'decorative-emoji', sev: 'warn',
    re: /[✨\u{1F680}\u{1F4A1}\u{1F525}\u{1F389}⚡\u{1F31F}\u{1FA84}\u{1F4AB}\u{1F44B}]/u,
    why: 'decorative emoji in UI copy' },
  { id: 'em-dash', sev: 'warn',
    re: /\u2014/,
    proseOnly: true,
    fix: fixEmDash, // safe deterministic repair (prose)
    why: 'em dash: a top AI-writing tell; use a comma, colon, or period' },
  { id: 'hype-copy', sev: 'error',
    re: /\b(boost your productivity|supercharge|unleash|game[- ]?chang(?:er|ing)|seamlessly|effortlessly|revolutioniz(?:e|ing)|take your .{1,30} to the next level|elevate your|cutting[- ]edge|powered by ai|next[- ]generation)\b/i,
    why: 'hype/marketing slop phrase: say the specific thing instead' },
  { id: 'kicker-dot-caps', sev: 'error',
    re: /[●◉]\s*[A-Z][A-Z0-9]+(?:\s+[A-Z0-9]+)*\b/,
    notFiles: /\.(md|mdx|txt)$/i, // prose/wireframe docs use ● as radio buttons and transport glyphs
    why: 'dot char + all-caps label: the status-dot eyebrow kicker, the #1 banned hero pattern' },
];

// Pair rules: two regexes that must BOTH hit within a small line window. Catches
// composites that span JSX lines (a dot element on one line, its label on the next).
const PAIR_RULES = [
  { id: 'hero-kicker', sev: 'error', span: 4,
    a: /rounded-full[^"'`]{0,80}\b[wh]-(?:1(?:\.5)?|2(?:\.5)?|3)\b|\b[wh]-(?:1(?:\.5)?|2(?:\.5)?|3)\b[^"'`]{0,80}rounded-full/i,
    b: /font-mono|tracking-(?:wide(?:r|st)?|\[)|text-\[?1[01]px|letter-spacing:\s*0?\.\d/i,
    why: 'tiny status dot next to a small mono/tracked kicker label: banned hero-kicker composite' },
  { id: 'pastel-icon-tile', sev: 'warn', span: 2,
    a: /\bbg-(?:indigo|violet|purple|fuchsia|blue|sky|cyan|teal|emerald|green|lime|amber|orange|rose|pink|red)-(?:50|100)\b/i,
    b: /\brounded(?:-(?:sm|md|lg|xl|2xl))?\b[^"'`]{0,80}\b(?:size-|[wh]-)(?:8|9|10|11|12|14|16)\b|\b(?:size-|[wh]-)(?:8|9|10|11|12|14|16)\b[^"'`]{0,80}\brounded(?:-(?:sm|md|lg|xl|2xl))?\b/i,
    why: 'pastel-tinted rounded icon tile (small light-100 square holding an icon): the generated feature-card reflex' },
];

const ICON = { error: '✗', warn: '⚠' }; // ✗  ⚠

const PROJECT_RULES_FILE = path.join('.atris', 'slop.rules.json');

// Compounding: projects grow their own anti-slop ruleset in .atris/slop.rules.json.
// Each entry: { id, pattern, flags?, why?, sev? }. Loaded on top of the built-ins.
function loadProjectRules(root = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, PROJECT_RULES_FILE), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.rules || []);
    return arr.map((r) => {
      if (!r || !r.id || !r.pattern) return null;
      let re; try { re = new RegExp(r.pattern, r.flags || 'i'); } catch { return null; }
      return { id: r.id, sev: r.sev === 'error' ? 'error' : 'warn', re, why: r.why || r.id, project: true };
    }).filter(Boolean);
  } catch { return []; }
}

function addProjectRule(rule, root = process.cwd()) {
  const file = path.join(root, PROJECT_RULES_FILE);
  let arr = [];
  try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); arr = Array.isArray(raw) ? raw : (raw.rules || []); } catch {}
  arr = arr.filter((r) => r.id !== rule.id);
  arr.push(rule);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(arr, null, 2) + '\n');
  return file;
}

// Map<absFile, Set<changedLineNumber>> from the working-tree (or --cached) git diff.
function gitChangedLines(staged, cwd = process.cwd(), range = null) {
  const map = new Map();
  let out;
  try {
    out = execFileSync('git', ['diff', '--unified=0', ...(staged ? ['--cached'] : []), ...(range ? [range] : [])], { encoding: 'utf8', cwd });
  }
  catch { return map; }
  let cur = null;
  for (const line of out.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) { cur = path.resolve(cwd, f[1]); map.set(cur, map.get(cur) || new Set()); continue; }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && cur) { const start = +h[1], count = h[2] != null ? +h[2] : 1; for (let i = 0; i < count; i++) map.get(cur).add(start + i); }
  }
  return map;
}

// Install a pre-commit hook that gates staged changes through `atris slop detect --staged`.
// Idempotent and non-destructive: appends a marked block, skips gracefully if atris is absent.
function installHook(root = process.cwd()) {
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('not a git repo (no .git here)');
  const hookDir = path.join(root, '.git', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'pre-commit');
  const marker = '# atris slop gate';
  let content = '';
  try { content = fs.readFileSync(hookPath, 'utf8'); } catch {}
  if (content.includes(marker)) return { hookPath, already: true };
  if (!content) content = '#!/bin/sh\n';
  if (!content.endsWith('\n')) content += '\n';
  content += `\n${marker}\nif command -v atris >/dev/null 2>&1; then atris slop detect --staged --quiet || exit 1; fi\n`;
  fs.writeFileSync(hookPath, content);
  fs.chmodSync(hookPath, 0o755);
  return { hookPath, already: false };
}

// Name the shape of a fix by the punctuation it added: an aside put in
// parentheses, a colon, a semicolon joining two sentences, a comma, a period,
// or a range hyphen. A line that gained none of these just had its dash
// dropped. Two shapes join with " + ". A mark carried onto the line above
// names both lines "<shape> moved up" (see applyFixes).
const FIX_KINDS = [['(', 'parentheses'], [':', 'colon'], [';', 'semicolon'], [',', 'comma'], ['.', 'period'], ['-', 'hyphen']];
function fixKind(before, after) {
  const count = (s, ch) => s.split(ch).length - 1;
  const kinds = FIX_KINDS.filter(([ch]) => count(after, ch) > count(before, ch)).map(([, k]) => k);
  return kinds.length ? kinds.join(' + ') : 'dropped';
}

// A dash that opens a wrapped line inside a paragraph joins it to the line
// above. Dropping it fuses two sentences ("checks below these are the
// reward"), so the mark it stands for, picked by the same clause rules as a
// dash in mid-line, goes on the end of the line above: "checks below;" then
// "these are the reward". Returns that mark, or null when the line above
// already ends in a mark, even inside a closing quote, is a heading, a table
// row or a fence, or either line holds another dash, and the dash is simply
// dropped as before. A line that is only a name or a credit signs off what
// came before ("Sanketh", "Brian Chesky, CEO of Airbnb"), so it is dropped too.
const CREDIT_LINE = /^(?:@\w+|\[[^\]]+\]|[A-Z][\w'\u2019.-]*(?: [A-Z][\w'\u2019.-]*){0,3})(?:,[^.!?;:]*| \([^)]*\))?$/;
function carriedMark(above, line) {
  const open = /^\s*\u2014[ \t]*(\S.*)$/.exec(line);
  if (!open || !above.trim() || /\u2014|`/.test(above) || /\u2014/.test(open[1]) || CREDIT_LINE.test(open[1].trim())) return null;
  if (/^\s{0,3}(?:#|>|\||```|~~~)/.test(above) || /^\s*(?:[-*+]|\d+[.)])\s*$/.test(above)) return null;
  if (!/[\w)\]"'*_%\u201d\u2019]$/.test(above) || /[.!?,;:]["'*_)\u201d\u2019]+$/.test(above)) return null;
  const head = above.trim();
  const joined = fixEmDash(`${head} \u2014 ${open[1]}`);
  const mark = joined.startsWith(head) && joined.endsWith(` ${open[1]}`) ? joined.slice(head.length, joined.length - open[1].length - 1) : '';
  return /^[,;:.]$/.test(mark) ? mark : ',';
}

// A dash that ends a line whose sentence wraps onto the next one is the same
// break as a dash in mid-line, so the clause rules read the two lines as one
// to pick its mark: "Re-interview to amend;" then "this is a living file",
// never a comma splice across the wrap. Returns a semicolon or colon, or null
// to leave the dash to the plain line-end comma: when either line holds code
// or another dash, the line is a heading, table row or fence, or the next
// line opens a new block, a list item or a quote. The next line must open on
// a plain subject ("this", "it", "we"), since a wrapped line that opens on
// any other word often finishes the subject above ("The tool we built" then
// "now ships to everyone") and keeps its comma.
// A pair of dashes around an aside can open on one line and close on the
// next. Read alone, each line sees one dash and gives it a comma or a
// semicolon: "Counting real items; merge commits, receipt files, / defects,
// beats grepping". Read together, the aside goes in parentheses the way it
// would on one line: "Counting real items (merge commits, receipt files, /
// defects) beats grepping". Only that outcome is kept, so diagram arrows
// and records that sit on their own lines stay as they are.
function splitAside(line, below) {
  if (!line.trim() || !below.trim() || /`/.test(line + below)) return null;
  if (line.split('\u2014').length !== 2 || below.split('\u2014').length !== 2) return null;
  if (!wrappedFrom(line, below)) return null;
  // a mark already beside a dash ("done; \u2014 next") or one word before the
  // first dash ("v2 \u2014 harness re-verified", a name) is no aside opening
  if (/[,;:.!?]\s*\u2014|\u2014\s*[,;:.!?]/.test(line + below)) return null;
  if (line.split('\u2014')[0].trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '').split(/\s+/).length < 2) return null;
  // lines that open with the same word, numbers and marks aside, are records
  // of their own: "stash@{40} older-window" then "stash@{41} older-window",
  // or a count on each line: "199/226" then "93"
  const opener = (s) => s.trim().split(/\s+/)[0].replace(/[^A-Za-z]+/g, '');
  if (opener(line) === opener(below)) return null;
  // a line that goes on with a sentence opens mid-sentence: in lowercase or
  // a word in capitals ("the / CRITICAL fix"), and under a list item it is
  // indented. "How execution flows" then "Works with Docs" are two lines.
  const first = below.trim().replace(/^[^A-Za-z0-9]+/, '').split(/[\s,.;:)]/)[0];
  if (!/^[a-z]/.test(first) && !/^[A-Z]{2,}$/.test(first)) return null;
  if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line) && !/^\s+\S/.test(below)) return null;
  const head = /^(\s*)(.*?)(\s*)$/.exec(line); const foot = /^(\s*)(.*?)(\s*)$/.exec(below);
  const tailWords = head[2].split('\u2014')[1].trim().split(/\s+/); const headWords = foot[2].split('\u2014')[0].trim().split(/\s+/);
  if (!tailWords[0] || !headWords[0]) return null;
  const seam = `${tailWords[tailWords.length - 1]} ${headWords[0]}`;
  const joined = fixEmDash(`${head[2]} ${foot[2]}`);
  const at = joined.indexOf(seam);
  if (at < 0 || joined.indexOf(seam, at + 1) >= 0) return null;
  const cut = at + tailWords[tailWords.length - 1].length;
  const up = joined.slice(0, cut); const down = joined.slice(cut + 1);
  if (/\u2014/.test(joined) || !/\([^)]*$/.test(up) || !/^[^(]*\)/.test(down)) return null;
  // a semicolon between the two dashes means each dash belongs to its own
  // item: "TeamTab \u2014 click member; PulseControl \u2014 refetch"
  if (/;/.test(up.slice(up.lastIndexOf('(')) + down.slice(0, down.indexOf(')')))) return null;
  return [head[1] + up + head[3], foot[1] + down + foot[3]];
}

function trailingMark(line, below) {
  const end = /^(.*?\S)\s*\u2014\s*$/.exec(line);
  if (!end || !below.trim() || /\u2014|`/.test(end[1]) || /\u2014|`/.test(below)) return null;
  if (!/^\s*(?:it|this|that|we|they|you|he|she|I|there)(?:['\u2019](?:s|re|ll|ve|d|m))?\s/.test(below)) return null;
  if (/^\s{0,3}(?:#|\||```|~~~)/.test(line) || /^\s*(?:#|>|\||```|~~~|[-*+]\s|\d+[.)]\s)/.test(below)) return null;
  const head = end[1].trim(); const next = below.trim();
  const joined = fixEmDash(`${head} \u2014 ${next}`);
  const mark = joined.startsWith(head) && joined.endsWith(` ${next}`) ? joined.slice(head.length, joined.length - next.length - 1) : '';
  return /^[;:]$/.test(mark) ? mark : null;
}

// Apply every fixable rule's safe transform in place.
// Returns { fixedCount, fixedFiles, changes }, where changes lists each edited
// line as { file, line, before, after, kind } so the writer can review the fix.
// With write: false it only reports what it would change (a dry run).
// The line above when this line carries on its sentence: neither is a list
// item, heading, table row or quote, and the line above ends without a stop.
function wrappedFrom(above, line) {
  const block = /^\s*(?:[-*+>|#]|\d+[.)]\s)/;
  if (!above || !above.trim() || block.test(line) || /^\s*[|#]/.test(above)) return '';
  if (/[.!?:;]["'*_)\u201d\u2019]*\s*$/.test(above)) return '';
  return above.replace(/^\s*(?:(?:[-*+>]|\d+[.)])\s+)?/, '');
}

function applyFixes(files, rules, { write = true } = {}) {
  const fixable = rules.filter((r) => typeof r.fix === 'function');
  let fixedCount = 0; const fixedFiles = []; const changes = [];
  for (const file of files) {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const skip = ownTableLines(file, lines);
    const markdown = MARKDOWN.test(file);
    const fenced = markdown ? fencedLines(lines) : new Set();
    const script = SCRIPT.test(file);
    const comments = { block: false, template: false };
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      const from = script ? commentStart(lines[i], comments) : 0;
      if (skip.has(i)) continue;
      let line = lines[i];
      // the line above and this one share one kind, "semicolon moved up", so
      // the report shows them side by side instead of filing this one as dropped
      let carried = null;
      const mark = !script && i > 0 && !skip.has(i - 1) && !fenced.has(i) && !fenced.has(i - 1) && fixable.some((r) => r.fix === fixEmDash) ? carriedMark(lines[i - 1], line) : null;
      if (mark) {
        const above = lines[i - 1].replace(/\s+$/, '') + mark;
        const last = changes[changes.length - 1];
        carried = `${fixKind(lines[i - 1], above)} moved up`;
        if (last && last.file === file && last.line === i) { last.after = above; last.kind = carried; }
        else changes.push({ file, line: i, before: lines[i - 1], after: above, kind: carried });
        lines[i - 1] = above; touched = true;
      }
      // a split aside fixes both lines at once; the line below is filed
      // right after this one so the report keeps their order
      let pairedBelow = null;
      const pair = !script && from === 0 && i + 1 < lines.length && !skip.has(i) && !skip.has(i + 1) && !fenced.has(i) && !fenced.has(i + 1) && fixable.some((r) => r.fix === fixEmDash) ? splitAside(line, lines[i + 1]) : null;
      if (pair) { line = pair[0]; fixedCount += 2; pairedBelow = { file, line: i + 2, before: lines[i + 1], after: pair[1], kind: fixKind(lines[i + 1], pair[1]) }; lines[i + 1] = pair[1]; }
      const tail = !script && i + 1 < lines.length && !skip.has(i) && !skip.has(i + 1) && !fenced.has(i) && !fenced.has(i + 1) && fixable.some((r) => r.fix === fixEmDash) ? trailingMark(line, lines[i + 1]) : null;
      if (tail) { line = line.replace(/\s*\u2014\s*$/, tail); fixedCount++; }
      for (const r of fixable) {
        const prose = markdown && r.proseOnly;
        if (prose && fenced.has(i)) continue;
        if (r.proseOnly && from === -1) continue;
        const at = r.proseOnly ? from : 0;
        // a code span is code in any file, a script comment or a plain text
        // note too: "`selection-\u2014-member`" names a slug, and a comma in it
        // would name a different one
        const { masked, spans, restore } = r.proseOnly ? maskInlineCode(line.slice(at)) : { masked: line.slice(at), spans: [], restore: (x) => x };
        if (!r.re.test(masked)) continue;
        const startsBlock = at === 0 && (i === 0 || !lines[i - 1].trim() || /^\s{0,3}#/.test(lines[i - 1]));
        const above = at === 0 && !script && !startsBlock && !fenced.has(i - 1) && !skip.has(i - 1) ? wrappedFrom(lines[i - 1], line) : '';
        const nl = line.slice(0, at) + restore(r.fix(masked, { endsBlock: i === lines.length - 1 || !lines[i + 1].trim(), startsBlock, spans, above }));
        if (nl !== line) { line = nl; fixedCount++; }
      }
      if (line !== lines[i]) { changes.push({ file, line: i + 1, before: lines[i], after: line, kind: carried || fixKind(lines[i], line) }); lines[i] = line; touched = true; }
      if (pairedBelow) { changes.push(pairedBelow); touched = true; }
    }
    if (touched) { if (write) fs.writeFileSync(file, lines.join('\n')); fixedFiles.push(file); }
  }
  return { fixedCount, fixedFiles, changes };
}

function walk(target, out) {
  let stat;
  try { stat = fs.statSync(target); } catch { return out; }
  if (stat.isFile()) {
    if (SCAN_EXTS.has(path.extname(target))) out.push(target);
    return out;
  }
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(target))) return out;
    for (const name of fs.readdirSync(target)) {
      if (name.startsWith('.') && name !== '.') continue;
      walk(path.join(target, name), out);
    }
  }
  return out;
}

// This file defines the slop patterns, so its own RULES and PAIR_RULES tables
// would match themselves. Return the line indexes inside those two tables when
// scanning this file, so a self-scan reports only real slop in the code, plus
// any line a writer marked to ignore.
// A writer can keep a line as written, say a bad example quoted on purpose:
// a line holding slop-ignore is skipped, and slop-ignore-next-line skips the
// line below it. In markdown the marker can sit in an HTML comment.
function ignoredLines(lines) {
  const skip = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('slop-ignore-next-line')) skip.add(i + 1);
    else if (lines[i].includes('slop-ignore')) skip.add(i);
  }
  return skip;
}

function ownTableLines(file, lines) {
  const skip = ignoredLines(lines);
  if (path.resolve(file) !== __filename) return skip;
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    if (!inside && /^const (?:RULES|PAIR_RULES) = \[/.test(lines[i])) inside = true;
    if (inside) skip.add(i);
    if (inside && /^\];/.test(lines[i])) inside = false;
  }
  return skip;
}

function scanFile(file, rules = RULES, pairRules = PAIR_RULES) {
  const findings = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return findings; }
  const lines = text.split('\n');
  const skip = ownTableLines(file, lines);
  const markdown = MARKDOWN.test(file);
  const fenced = markdown ? fencedLines(lines) : new Set();
  for (let i = 0; i < lines.length; i++) {
    if (skip.has(i)) continue;
    const line = lines[i];
    for (const rule of rules) {
      if (rule.notFiles && rule.notFiles.test(file)) continue;
      const prose = markdown && rule.proseOnly;
      if (prose && fenced.has(i)) continue;
      const m = rule.re.exec(prose ? maskInlineCode(line).masked : line);
      if (m) {
        findings.push({
          file, line: i + 1, rule: rule.id, sev: rule.sev, why: rule.why,
          snippet: m[0].trim().slice(0, 48),
        });
      }
    }
  }
  for (const pr of pairRules) {
    for (let i = 0; i < lines.length; i++) {
      if (skip.has(i) || !pr.a.test(lines[i])) continue;
      const lo = Math.max(0, i - pr.span), hi = Math.min(lines.length - 1, i + pr.span);
      for (let j = lo; j <= hi; j++) {
        if (!skip.has(j) && pr.b.test(lines[j])) {
          findings.push({
            file, line: i + 1, rule: pr.id, sev: pr.sev, why: pr.why,
            snippet: lines[i].trim().slice(0, 48),
          });
          break;
        }
      }
    }
  }
  return findings;
}

// Programmatic scanner for landing gates. Callers provide the exact candidate
// paths, so this never widens into a repo scan. An optional changed-lines map
// keeps branch-diff gates on the lines the candidate actually added or edited.
function scanPaths(targets, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const rules = options.rules || RULES.concat(loadProjectRules(root));
  const pairRules = options.pairRules || PAIR_RULES;
  const changedLines = options.changedLines instanceof Map ? options.changedLines : null;
  const seen = new Set();
  const files = [];
  for (const target of Array.isArray(targets) ? targets : [targets]) {
    if (!target) continue;
    for (const file of walk(path.resolve(root, target), [])) {
      const absolute = path.resolve(file);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      files.push(absolute);
    }
  }
  let findings = files.flatMap((file) => scanFile(file, rules, pairRules));
  if (changedLines) {
    findings = findings.filter((finding) => {
      const lines = changedLines.get(path.resolve(finding.file));
      return lines && lines.has(finding.line);
    });
  }
  return { root, files, findings };
}

function detect(argv) {
  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const dryRun = argv.includes('--dry-run');
  const doFix = dryRun || argv.includes('--fix');
  const staged = argv.includes('--staged');
  const diffMode = staged || argv.includes('--diff');
  const rules = RULES.concat(loadProjectRules());

  // pick the file set: a git diff (changed files) or a path walk
  let files, changed = null;
  if (diffMode) {
    changed = gitChangedLines(staged);
    files = [...changed.keys()].filter((f) => SCAN_EXTS.has(path.extname(f)) && fs.existsSync(f));
  } else {
    let targets = argv.filter((a) => !a.startsWith('-'));
    if (!targets.length) targets = ['.'];
    const seen = new Set();
    files = [];
    for (const target of targets) {
      for (const f of walk(path.resolve(target), [])) {
        if (!seen.has(f)) { seen.add(f); files.push(f); }
      }
    }
  }

  let fixed = null;
  if (doFix) {
    fixed = applyFixes(files, rules, { write: !dryRun });
    if (!json && fixed.fixedCount) {
      console.log(`\n  ✎ ${dryRun ? 'would fix' : 'fixed'} ${fixed.fixedCount} tell${fixed.fixedCount === 1 ? '' : 's'} in ${fixed.fixedFiles.length} file${fixed.fixedFiles.length === 1 ? '' : 's'}`);
      // group the edits by shape, biggest first, so a writer reviews a large
      // fix one kind at a time instead of hundreds of lines in a row
      const groups = new Map();
      for (const c of fixed.changes) groups.set(c.kind, [...(groups.get(c.kind) || []), c]);
      const byKind = [...groups].sort((a, b) => b[1].length - a[1].length);
      console.log(`    by kind: ${byKind.map(([k, cs]) => `${k} ${cs.length}`).join(', ')}`);
      if (!quiet) {
        for (const [kind, cs] of byKind) {
          console.log(`\n    ${kind} (${cs.length})`);
          for (const c of cs) {
            console.log(`\n    ${path.relative(process.cwd(), c.file)}:${c.line}\n      before  ${c.before.trim()}\n      after   ${c.after.trim()}`);
          }
        }
      }
    }
  }

  let findings = files.flatMap((f) => scanFile(f, rules));
  if (diffMode && changed) findings = findings.filter((f) => changed.get(f.file) && changed.get(f.file).has(f.line));
  const errors = findings.filter((f) => f.sev === 'error').length;

  if (json) {
    console.log(JSON.stringify({
      ok: findings.length === 0, scanned: files.length,
      mode: diffMode ? (staged ? 'staged' : 'diff') : 'path',
      fixed: fixed ? fixed.fixedCount : 0,
      dryRun,
      changes: fixed ? fixed.changes.map((c) => ({ ...c, file: path.relative(process.cwd(), c.file) })) : [],
      slop: findings.length, errors,
      findings: findings.map((f) => ({ ...f, file: path.relative(process.cwd(), f.file) })),
    }, null, 2));
    return findings.length ? 1 : 0;
  }

  const rel = (f) => path.relative(process.cwd(), f);
  if (!quiet) {
    if (!findings.length) {
      console.log(`\n  ✓ clean, no slop tells in ${files.length} file${files.length === 1 ? '' : 's'}`);
    } else {
      console.log('');
      const w = Math.max(...findings.map((f) => `${rel(f.file)}:${f.line}`.length));
      for (const f of findings) {
        const loc = `${rel(f.file)}:${f.line}`.padEnd(w);
        console.log(`  ${ICON[f.sev]} ${loc}  ${f.rule.padEnd(20)} ${f.why}`);
      }
    }
  }
  if (findings.length) {
    console.log(`\n  ${findings.length} slop tell${findings.length === 1 ? '' : 's'} (${errors} error) · exit 1\n`);
  } else if (quiet) {
    console.log(`  ✓ clean · exit 0`);
  }
  return findings.length ? 1 : 0;
}

// --- dead-code detector: `atris slop dead` ------------------------------------
// Dead code is slop too. Deterministic require-graph reachability: BFS from the
// package entrypoints (package.json bin/scripts, bin/, scripts/) over static
// require()/import edges. A JS file nothing reaches AND nothing names is dead.
// Safety net for dynamic dispatch: any file whose basename appears as a string
// literal anywhere in the repo is treated as referenced (protects --legacy
// loops, docs-driven loading, and require(path.join(...)) patterns).

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*(?:import|export)\s[^'"\n]*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function listJsFiles(dir, out = []) {
  let names; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) listJsFiles(p, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(p);
    else if (!name.includes('.') && st.isFile() && isNodeScript(p)) out.push(p); // extensionless node scripts (bin entries, `ax`) consume exports too
  }
  return out;
}

function isNodeScript(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(80);
    const n = fs.readSync(fd, buf, 0, 80, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, n);
    return head.startsWith('#!') && head.includes('node');
  } catch { return false; }
}

// Resolve a relative specifier from `fromFile` to an absolute file path, or null.
function resolveSpec(spec, fromFile) {
  if (!spec || !spec.startsWith('.')) return null; // bare specifiers = node builtins/deps
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')]) {
    try { if (fs.statSync(cand).isFile()) return cand; } catch {}
  }
  return null;
}

function requireEdges(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const edges = [];
  let m;
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(text))) {
    const resolved = resolveSpec(m[1] || m[2] || m[3], file);
    if (resolved) edges.push(resolved);
  }
  return edges;
}

// Entrypoints: package.json bin values, node-invoking scripts, bin/, scripts/.
function deadEntrypoints(root) {
  const entries = new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {});
    for (const b of bins) { const p = path.resolve(root, b); if (fs.existsSync(p)) entries.add(p); }
    for (const cmd of Object.values(pkg.scripts || {})) {
      for (const ref of String(cmd).match(/[\w./-]+\.(?:js|mjs|cjs)\b/g) || []) {
        const p = path.resolve(root, ref); if (fs.existsSync(p)) entries.add(p);
      }
    }
  } catch {}
  for (const dir of ['bin', 'scripts']) listJsFiles(path.join(root, dir)).forEach((f) => entries.add(f));
  return entries;
}

function findDeadCode(root = process.cwd(), opts = {}) {
  root = path.resolve(root);
  const scanDirs = (opts.dirs || ['commands', 'lib']).map((d) => path.join(root, d));
  const candidates = scanDirs.flatMap((d) => listJsFiles(d));
  if (!candidates.length) return { root, candidates: 0, dead: [], testOnly: [] };

  // 1) reachability BFS from entrypoints over static edges
  const reached = new Set();
  const queue = [...deadEntrypoints(root)];
  while (queue.length) {
    const f = queue.pop();
    if (reached.has(f)) continue;
    reached.add(f);
    queue.push(...requireEdges(f));
  }

  // 2) test reachability (a file only tests import = suspicious, not proven dead)
  const testReached = new Set();
  const tq = listJsFiles(path.join(root, 'test'));
  while (tq.length) {
    const f = tq.pop();
    if (testReached.has(f)) continue;
    testReached.add(f);
    tq.push(...requireEdges(f));
  }

  // 3) string-mention safety net: basename (sans ext) named as a string literal
  //    outside itself. Split by scope: a mention in a NON-test file (prod code, a
  //    bin entry like `ax`) means the file is dynamically dispatched, e.g.
  //    require(path.join(__dirname, 'lib', 'permission-grants.js')), and is
  //    genuinely reachable even though the static edge parser and the test BFS
  //    can't see the edge. That must outrank the test-only classification, or a
  //    live feature imported by both `ax` and a test reads as "feature gone".
  const testDir = path.join(root, 'test');
  const isTestFile = (f) => f === testDir || f.startsWith(testDir + path.sep);
  const allRepoJs = [...new Set([...listJsFiles(root)])];
  const mentionedBy = (file, predicate) => {
    const stem = path.basename(file).replace(/\.(js|mjs|cjs)$/, '');
    const re = new RegExp(`['"\`/]${escapeRegExp(stem)}(?:\\.js)?['"\`]`);
    return allRepoJs.some((f) => {
      if (f === file || !predicate(f)) return false;
      try { return re.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
    });
  };
  const mentionedInProd = (file) => mentionedBy(file, (f) => !isTestFile(f));
  const mentioned = (file) => mentionedBy(file, () => true);

  const dead = [], testOnly = [];
  for (const c of candidates) {
    if (reached.has(c)) continue;
    if (mentionedInProd(c)) continue; // dynamically dispatched from prod (e.g. the `ax` bin), reachable
    if (testReached.has(c)) { testOnly.push(c); continue; }
    if (mentioned(c)) continue; // docs-driven / other dynamic dispatch, not provably dead
    dead.push(c);
  }
  return { root, candidates: candidates.length, dead: dead.sort(), testOnly: testOnly.sort() };
}

// Orphaned exports: names a module exports that no other file ever mentions.
// Word-boundary search across every other JS file keeps this high-precision:
// a name used anywhere (import, dynamic access, test, doc string) never flags.
function exportedNames(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const names = new Set();
  // module.exports = { a, b: c, ... }, shorthand entries and keys
  const block = text.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/);
  if (block) {
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*[,:]?\s*(?:\/\/.*)?$/) || line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
      if (m) names.add(m[1]);
    }
  }
  // exports.foo = / module.exports.foo =
  for (const m of text.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  return [...names];
}

function findOrphanedExports(root, files, allRepoJs) {
  const texts = new Map();
  const readText = (f) => {
    if (!texts.has(f)) { try { texts.set(f, fs.readFileSync(f, 'utf8')); } catch { texts.set(f, ''); } }
    return texts.get(f);
  };
  // Token index instead of a per-name regex pass over every file: one read +
  // tokenize per file, then O(1) name lookups. The regex version took nearly a
  // minute on this repo, which kept this detector out of the landing gate.
  // Identifiers split on `$` so `foo` still matches inside `foo$bar`, matching
  // the old \b semantics; the rare `$`-carrying name falls back to the regex.
  const tokens = new Map();
  const tokensOf = (f) => {
    if (!tokens.has(f)) tokens.set(f, new Set(readText(f).match(/[A-Za-z0-9_]+/g) || []));
    return tokens.get(f);
  };
  const orphans = [];
  for (const file of files) {
    for (const name of exportedNames(file)) {
      if (name.length < 4) continue; // generic short names drown in noise either way
      const usesRegex = name.includes('$');
      const re = usesRegex ? new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`) : null;
      const used = allRepoJs.some((f) => f !== file
        && (usesRegex ? re.test(readText(f)) : tokensOf(f).has(name)));
      if (!used) orphans.push({ file, name });
    }
  }
  return orphans;
}

function deadCommand(argv) {
  const json = argv.includes('--json');
  const withExports = argv.includes('--exports');
  const root = argv.find((a) => !a.startsWith('-')) || '.';
  const res = findDeadCode(root);
  const rel = (f) => path.relative(res.root, f);

  let orphans = null;
  if (withExports && res.candidates) {
    const scanDirs = ['commands', 'lib'].map((d) => path.join(res.root, d));
    const files = scanDirs.flatMap((d) => listJsFiles(d));
    orphans = findOrphanedExports(res.root, files, listJsFiles(res.root));
  }

  const bad = res.dead.length + (orphans ? orphans.length : 0);
  if (json) {
    console.log(JSON.stringify({
      ok: bad === 0, candidates: res.candidates,
      dead: res.dead.map(rel), test_only: res.testOnly.map(rel),
      ...(orphans ? { orphaned_exports: orphans.map((o) => ({ file: rel(o.file), name: o.name })) } : {}),
    }, null, 2));
    return bad ? 1 : 0;
  }
  if (!bad && !res.testOnly.length) {
    console.log(`\n  ✓ no dead code, all ${res.candidates} files reachable from the entrypoints\n`);
    return 0;
  }
  console.log('');
  for (const f of res.dead) console.log(`  ✗ ${rel(f).padEnd(40)} unreachable and unreferenced, delete it`);
  for (const f of res.testOnly) console.log(`  ⚠ ${rel(f).padEnd(40)} only tests import it, feature gone, test lingers?`);
  if (orphans) for (const o of orphans) console.log(`  ⚠ ${`${rel(o.file)} → ${o.name}`.padEnd(40)} exported but nothing anywhere names it, drop the export entry`);
  const parts = [`${res.dead.length} dead`, `${res.testOnly.length} test-only`];
  if (orphans) parts.push(`${orphans.length} orphaned export${orphans.length === 1 ? '' : 's'}`);
  console.log(`\n  ${parts.join(', ')} of ${res.candidates} files · exit ${bad ? 1 : 0}\n`);
  return bad ? 1 : 0;
}

function slopCommand(argv) {
  let sub = argv[0];
  if (sub === 'dead') return deadCommand(argv.slice(1));
  if (sub === '-h' || sub === '--help') sub = 'help';
  if (!sub || sub === 'detect' || sub.startsWith('-') || !['detect', 'rules', 'help', 'hook', 'install-hook'].includes(sub)) {
    // default + `detect`: scan. Bare `atris slop` scans cwd too.
    const rest = sub === 'detect' ? argv.slice(1) : argv;
    return detect(rest);
  }
  if (sub === 'hook' || sub === 'install-hook') {
    try {
      const { hookPath, already } = installHook();
      console.log(already
        ? `\n  already installed: ${path.relative(process.cwd(), hookPath)}\n`
        : `\n  ✓ slop pre-commit gate installed: ${path.relative(process.cwd(), hookPath)}\n    every commit now runs: atris slop detect --staged\n`);
      return 0;
    } catch (e) { console.error(`  ${e.message}`); return 2; }
  }

  if (sub === 'rules') {
    if (argv.includes('--add')) {
      const rest = argv.slice(argv.indexOf('--add') + 1).filter((a) => !a.startsWith('-'));
      const [id, pattern, ...whyParts] = rest;
      if (!id || !pattern) { console.error('  usage: atris slop rules --add <id> <regex-pattern> <why...> [--sev error|warn]'); return 2; }
      let valid = true; try { new RegExp(pattern, 'i'); } catch { valid = false; }
      if (!valid) { console.error(`  invalid regex: ${pattern}`); return 2; }
      const sev = (argv[argv.indexOf('--sev') + 1] === 'error') ? 'error' : 'warn';
      const file = addProjectRule({ id, pattern, why: whyParts.join(' ') || id, sev });
      console.log(`  ✓ added project rule "${id}" to ${path.relative(process.cwd(), file)}`);
      return 0;
    }
    const project = loadProjectRules();
    console.log('\n  atris slop, deterministic rules:\n');
    for (const r of RULES) console.log(`  ${ICON[r.sev]} ${r.id.padEnd(20)} ${r.why}`);
    for (const r of project) console.log(`  ${ICON[r.sev]} ${r.id.padEnd(20)} ${r.why}  (project)`);
    console.log(`\n  ${RULES.length} built-in${project.length ? ` + ${project.length} project` : ''} rule${RULES.length + project.length === 1 ? '' : 's'}\n`);
    return 0;
  }
  // help
  console.log(`
  atris slop, deterministic slop detector + repairer (no LLM)

    atris slop detect [path...]   scan one or more files or dirs (default: .)
    atris slop detect --diff      scan only changed lines (commit/PR gate)
    atris slop detect --staged    scan only staged changes (pre-commit hook)
    atris slop detect --fix       auto-repair the safe tells (em dashes), report the rest
    atris slop detect --dry-run   show what --fix would change, write nothing
    atris slop detect [path...] --json   machine output for CI / the loop
    atris slop rules              list active rules (built-in + project)
    atris slop rules --add <id> <pattern> <why>   grow the project ruleset
    atris slop hook               install a pre-commit gate (runs --staged)
    atris slop dead [root]        find dead JS (unreachable + unreferenced files)

  Keep a line as written (a bad example quoted on purpose) by putting
  slop-ignore on it, or slop-ignore-next-line on the line above it.
  Project rules live in .atris/slop.rules.json and compound over time.
  exit 0 = clean, 1 = slop found. Wire into PR checks and the autopilot gate.
`);
  return 0;
}

module.exports = { slopCommand, detect, scanFile, scanPaths, RULES, PAIR_RULES, loadProjectRules, addProjectRule, gitChangedLines, applyFixes, fencedLines, installHook, findDeadCode, findOrphanedExports, listJsFiles };
