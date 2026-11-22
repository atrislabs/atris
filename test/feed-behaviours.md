# atris feed: what it does, and the test that proves each

One line per behaviour, the test that proves it, and whether a failure blocks a release. Rows marked "found" are real failures seen while building the feed; each now has a test so it cannot come back unseen. Run the release rows with `node scripts/feed-behaviours.js` (it prints pass or fail per row and exits 1 if any release row fails).

Some found failures live in the desktop app or the backend. Their rows here prove the command line's side; the screen's own fix is checked in its own repo.

| # | Behaviour | Test | Blocks release |
|---|-----------|------|----------------|
| 1 | Words a person reads pass the same plain-words check as the cloud feed | plain words: the backend must-fail and must-pass examples | yes |
| 2 | Every kind of picture on a card is kept exactly as written | visuals: every kind round-trips unchanged | no |
| 3 | A drawing that could run code or reach outside is refused, never cleaned up | visuals: every unsafe drawing is refused, never repaired | yes |
| 4 | Each local task state becomes the right card | cards: each local task state maps to its card | yes |
| 5 | Technical titles are kept behind the detail, never shown | cards: a jargon title is kept in detail, never shown | no |
| 6 | A result says verified only when a real passing check exists | proof: verified only when a real passing receipt exists | yes |
| 7 | found: the goal showed in lowercase; it now shows exactly as typed | theme: reuses the atris goal, one plain sentence, people only | yes |
| 8 | An idea must say how it moves the goal, in plain words | propose: why is required once a goal is set, and jargon is refused by name | yes |
| 9 | found: work started before approval; an idea now waits for a person | propose: the idea must not start before a person approves it | yes |
| 10 | found: copies of the same idea; a near copy now backs the first card | propose: the same title returns the waiting card; a near copy backs it | yes |
| 11 | One member cannot flood the feed with ideas | propose: each member has a cap of waiting ideas | no |
| 12 | Approving starts the member once, never twice | decide: approve hands the idea to its member and starts it exactly once | yes |
| 13 | At most two members run at once; the rest wait in order | decide: at most two members run at once; the rest wait in order | yes |
| 14 | Approved work runs on the member's model and the line moves on | decide: the runner starts the member on the model in effect, marks the run ended and starts the next | yes |
| 15 | Dismissing an idea takes it off every normal list | decide: dismiss archives the idea so it leaves every normal list | yes |
| 16 | Only a person decides; an agent never can | decide: an agent can never decide, even with proof-only switched off | yes |
| 17 | Money, customer and other protected work waits for a person to start it | decide: work in a protected lane is handed over but waits for a person to start it | yes |
| 18 | Accepting finished work goes through the normal human accept | decide: approving finished work goes through the human accept path | yes |
| 19 | A question held for a person starts its member once answered yes | decide: approving a held question drops the hold and starts its member | no |
| 20 | Only the member who proposed an idea can rewrite it, while it waits | revise: only the proposing member, only while it waits | no |
| 21 | found: the end of the feed was unreachable; every card can be paged to | list: --since returns only cards that changed, and paging walks every card | yes |
| 22 | found: all cards mounted at once; the list comes in pages | queue: the cursor names cards already sent, so a pass between pages skips nothing | yes |
| 23 | The feed answers fast from the command line in the cloud shape | cli: atris feed cards --json answers from the fast path in the cloud shape | yes |
| 24 | Undecided ideas come first, then unread results, oldest first | queue: ideas first (never passed, then fewest passes, then newest), then unread results oldest first | no |
| 25 | Scrolling past holds an idea back, three times parks it, a rewrite brings it back | queue: a pass holds an idea back for 30 minutes; three passes park it; revising brings it back | no |
| 26 | A read result leaves the main list | queue: a read result leaves the default list and stays under done | no |
| 27 | Scripts that read the old group feed keep working for one release | cli: a bare call whose output is not a terminal keeps the old group feed for one release, and says so | yes |
| 28 | feed list and feed post stay the business group feed | routing: feed list and feed post stay the business group feed | yes |
| 29 | A model that is missing sends the card back with a reason; the next approve works | recover: a model missing at the start sends the card back with a plain reason, and the next approve works | yes |
| 30 | found: approved work stuck when its run failed; it now goes back to waiting, results kept | recover: a run that fails mid-way goes back to waiting; one that wrote its result keeps it | yes |
| 31 | found: a result was lost when the time limit hit; it is now kept | recover: a run past its time limit is stopped; a result already written is kept, otherwise the card says so | yes |
| 32 | After a restart, results are picked up, dead runs cleared, the line resumes in order | recover: after a restart, finished results are picked up, dead runs cleared, their cards wait again, and the line moves in order | yes |
| 33 | A run long past its limit is stopped by the next command | recover: a run alive but long past its limit is stopped by the next command | yes |
| 34 | Two commands at once never start work twice or break the state | recover: two commands at once never start the same work twice or break the state file | yes |
| 35 | No network on a cloud model is said plainly; local models still work | recover: no network on a cloud model says so plainly; the message stays and a resend on a local model works | yes |
| 36 | A failed reply keeps the message and never leaves endless typing | recover: a reply that throws leaves the message, no pending reply, and the person can send again | yes |
| 37 | A broken state file is kept aside, never a crash | recover: a broken run list is kept aside and the line starts fresh, without a crash | yes |
| 38 | Repair says what it fixed and resumes the line | repair: says what it fixed, clears a reply that never came, and resumes the line | yes |
| 39 | The ready check names the one thing to do and exits non-zero when not ready | doctor: ready when everything is, and names the one thing to do when not | yes |
| 40 | 200 rounds with failures and a restart leave no copies and nothing stuck | soak: 200 rounds with a failing, slow model and a restart leave no copies, nothing stuck, and an empty line | yes |
| 41 | The models list says what can run here, local and cloud, and why not | engines: what can run here, local and cloud, each with a reason when it cannot | yes |
| 42 | One default model; a pick that cannot run is refused, never saved | settings: one default model, stored in the project atris config; an unavailable pick is refused, never saved | yes |
| 43 | A member's own model, else the feed default, else the house pick (Codex here, else Atris 2 Fast; never a costly model unless a person picked it for the feed) | settings: a member's own roster line, else the feed default, else the house pick | yes |
| 44 | ON and OFF use the existing member switch; nobody is on by accident | members: on or off from the existing member switch; a member nobody switched on is off | yes |
| 45 | Approving an idea from an OFF member says so and starts nothing | members: approving an idea from an OFF member says so and starts nothing | yes |
| 46 | An approval whose model cannot run is refused plainly | members: an approval whose model cannot run here is refused plainly | yes |
| 47 | found: chat was not answering; the member now answers at once, streamed | talk: the member answers at once in one turn, streamed, outside the work queue | yes |
| 48 | A change asked for in chat comes back as a checked revision | talk: a change the person asks for comes back as a revision, through the revise checks | no |
| 49 | A technical answer goes to detail; OFF or missing models are said plainly | talk: a jargon answer is kept as detail; an OFF member or a missing model is said plainly | yes |
| 50 | The chat turn has no tools and cannot change anything | talk: the turn command is tool-free and streams on Claude; read-only on Codex | yes |
| 51 | found: card talks leaked to the group feed; they now stay on the card | talk: a card conversation stays on the card: nothing reaches the board or the feed events | yes |
| 52 | found: replies were billed to the business; a cloud reply uses the person's own sign-in | talk: a cloud reply runs on the person's own sign-in, never another key | yes |
| 53 | found: the app could not stream chat; the command says it streams, and ends a failed stream | cli: feed talk --help names --stream, so the app streams replies instead of waiting | yes |
| 54 | Every ping, talk, approval and result lands in the member's own log | log: pings, talk, approvals and results land in the member's own log | no |
| 58 | Progress and results come only from the member doing the work, with proof | emit: ideas go through the propose rules; progress and results only from the member doing the work | yes |
| 59 | The same events read from atris channel feed without a hosted board | emit: the same stream reads from atris channel feed when there is no hosted board | no |
| 60 | Scrolling asks up to three ON members, with the person's taste | more: the person asks up to three ON members for more, with the person's taste in their brief | yes |
| 61 | found: member runs failed in a folder outside git; start now gives it one starting point | start: a folder of projects gets atris, a starter team turned on, and a first read-only ping; idempotent | yes |
| 62 | Code is shown as code, held to size and plain text, its caption to plain words | visuals: code is shown as code, held to size and plain text, its caption to plain words | yes |
| 63 | A code visual never becomes a card's title, why or story | visuals: a code visual never becomes the card's title, why or story | yes |
| 64 | A picture file must be a real picture inside the project or ~/.atris | visuals: a picture file inside the project or ~/.atris; escapes, links out, fakes and big files are refused | yes |
| 65 | Members are told to bring one real visual when proposing, revising and finishing | visuals: members are told to bring one, from real content, when proposing, revising and finishing | no |
| 66 | Finished code work shows the member's picture, else its real changed lines | visuals: a finished result carries the member's own picture, else its real changed lines | yes |

| 55 | found: chat-speed ideas: cards stream in as they are written and pass the normal checks | stream: cards come in as they are written, then pass the normal checks | yes |
| 56 | A card cut off mid-way, or failing the checks, is dropped and nothing half-made is created | stream: a card cut off mid-way, or one that fails the checks, is dropped and nothing half-made is created | yes |
| 57 | Up to three members think at once, outside the work queue | stream: up to three members think at once, outside the work queue | yes |
| 67 | One thought in flight per member; a plain ping returns at once | stream: one thought in flight per member; without --stream the thinking runs in the background | yes |
| 68 | Limits by who pays, with a plain reason and when they reset; credits reported | limits: generous on this computer's models, tighter on paid ones, with a plain reason and when it resets | yes |
| 69 | Members rotate, ideas differ from what is there, a member whose ideas keep missing rests | variety: members rotate, ideas must be unlike what is there, and a member whose ideas keep missing rests | no |
| 70 | Pings stop when nobody is on, for agents and on battery saver | ping: off when no member is ON; refuses agents and battery saver | yes |
| 71 | The streamed ping prints one JSON event per line | cli: atris feed ping --stream prints one JSON event per line | yes |
| 72 | found: the same short idea from two members made two cards; it now merges, even once approved | copies: the same short title from two members, or a copy of an idea already approved, makes no second card | yes |
| 73 | A card the model forgot to close is whole when its answer ended normally | stream: a card the model forgot to END is still whole when the answer ended normally | no |
| 74 | found: at the end of the feed with 9 ideas waiting (most held back) no new ideas came; asking for more is now always heard | found: at the end of the feed with many ideas waiting (most held back), a change in the project still brings the team in | yes |
| 75 | found: the day's count read 0 after the members were asked; asks recorded earlier still count | found: asks recorded by the earlier feed still count toward the day, so the ready check never reads zero | yes |
| 76 | With few ideas on screen, a passed idea comes back after 5 minutes | found: with few ideas on screen, a passed idea comes back after 5 minutes, after the newer ones | yes |
| 77 | A refused ask says why in plain words, with the reset time, in the answer and the stream | refusals: a day limit says so plainly with the reset time, in the answer and in the stream | yes |
| 78 | Ideas are grounded in a small digest of the journal, features, wiki, tasks and decisions, never archives | digest: the journal, features, wiki, tasks and decisions, small, from indexes, never archives | yes |
| 79 | Every idea round and talk turn gets the digest and the member's mission, and asks for connected ideas | digest: every idea round and talk turn gets it, with the member's mission, and asks for connected ideas | yes |
| 80 | Each idea names what sparked it in plain words; the exact file stays in detail | source: each idea names what sparked it on the card, with the exact file only in detail | yes |
| 81 | A member that cannot say what sparked its ideas is asked less often | source: a member that cannot say what sparked its ideas is asked less often | no |
| 82 | A picture that is not about the card, empty or decorative is left off | visuals: a picture not about the card, empty or decorative is left off; the card stays | yes |
| 83 | Charts and numbers only from real numbers in the named project file | visuals: a chart only from real numbers found in the named project file | yes |
| 84 | A reply can offer quick choices, and a tap answers with one | choices: a reply can offer up to four quick picks; choosing one answers with it | no |
| 85 | What the owner teaches in a conversation is kept, shown back, used later and can be forgotten | notes: a lasting preference said in a conversation is kept, shown back, used in later rounds, and can be forgotten | yes |
| 86 | found: after a few rounds the end of the feed said the team was resting; thirty asks in a row each bring new cards | found: thirty presses of refresh in a row with two awake members, passing every idea, each bring a new card | yes |
| 87 | found: scrolling past counted as a rejection and rested every member; now only dismissals lower a member's turn | found: scrolling past is not a no; dismissals only move a member down the line | yes |
| 88 | found: the per-member gap refused whole asks; the ask now waits a few seconds or asks someone else | limits: generous on this computer's models, tighter on paid ones, with a plain reason and when it resets | yes |
| 89 | found: the waiting cap silenced members; scrolled-past ideas no longer count and the oldest make room | found: a member at its waiting cap retires its oldest scrolled-past ideas instead of falling silent | yes |
| 90 | found: a member's own daily emit cap dropped every idea after 30; asked-for ideas follow the day's ask limit | found: ideas from an ask are held to the day's limit, not the member's own daily emit cap | yes |
| 91 | An ask whose thinker crashed or ran long clears, and the next ask goes ahead | found: an ask whose thinker crashed clears, and the next ask goes ahead | yes |
| 92 | The end of the feed rests only for the day's limit or nobody awake, with a plain reason | found: the end of the feed rests only for the day's limit or nobody awake, each with its plain reason | yes |
| 93 | An empty round tries once more for different ideas and says plainly if still empty | stream: a card cut off mid-way, or one that fails the checks, is dropped and nothing half-made is created | yes |
| 94 | found: a new card appeared at the top while the person read at the bottom; the reading queue now grows at the end | order: the reading queue grows at the end, and paging stays steady while ideas arrive | yes |
| 95 | found: generated cards seemed to vanish; every card made stays listed, and a copy shows the card it joined | keep: every card made is in the default list until decided or passed; a near copy says which card it joined | yes |
| 96 | A plain-words slip gets one rewrite before a drop, and every drop is logged in feed events | keep: a plain-words slip gets one rewrite by the member before it is dropped, and drops are logged | yes |
| 97 | found: a card could be passed before it was ever seen; new or unseen cards are left alone | pass: a card made seconds ago, or one never on screen, is not passed; old calls keep working | yes |
| 98 | Every finished card is a real task a fresh process reads back | keep: every finished card is a real task that a fresh process reads back | yes |
| 99 | found: a finished card read only "A piece of work finished"; it now shows the plain words the work reported, else it waits under done | cards: finished work with a jargon title shows the plain words it reported; with none it waits under done | yes |
| 100 | found: old posts kept showing; a result or note quiet for a day leaves the main list, an idea waiting for you never does | fresh: a result and a team note quiet for a day leave the main list; an idea waiting for you stays; a comment brings a note back | yes |
| 101 | found: some posts could not be dismissed; any card can be, for you only, and brought back | dismiss: any card leaves your feed; an idea waiting for you is dismissed as a decision; undo brings a hidden card back | yes |
| 102 | found: teammates answered a question with only more questions; such an answer is not saved and says why | a teammate who only asks a question back is not saved: its pick fails with that reason, counts for the day and is not asked again by itself | yes |
| 103 | found: day-old posts stayed because teammates kept commenting on them; comments keep a card fresh only in the person's own conversation, and the team is no longer shown a card that left the list | fresh: teammates answering each other do not hold an old note on the main list; in your own conversation they do | yes |
| 104 | found: a person could not bring another teammate in to review; a comment naming @member gets that member's answer once, right away, never the work, and `feed reply --json` says who in `tagged` | naming a teammate with @ on any card: that teammate answers that comment once, right away, as an answer; never the work | yes |
| 105 | Several names each answer once in turn; an unknown name stays plain text; a sleeping one is said in `tag_note` | several names: each named member answers once, in turn; an unknown name stays plain text; a sleeping one is said plainly | no |
| 106 | A named member who only asks a question back saves nothing, the card says so, and --retry asks the same member again | a named member who only asks a question back: nothing is saved, the card says so, and --retry asks the same member again | no |
| 107 | found: held work read "A team member has a question for you" or showed only a job title; it now says who does it, why and what done looks like | held work you can approve says what you get: the member who does it, why, and what done looks like; never the question line | yes |
| 108 | Held work with no plain words and nothing explaining it stays off the main list, under needs_decision only | held work with no plain words and nothing explaining it stays off the main list, reachable under needs_decision, never titled as a question | yes |
| 109 | found: approving a teammate's question started work; a question is now answered in the comments, never approved, and can still be dismissed | a teammate's question is answered in the comments, never approved; it can still be talked over and dismissed | yes |
| 110 | found: a card read "The work ended without a result (tick-ok)."; a known status is said in words, an unknown one and an exit number say nothing | work that ended with nothing says why in words: a status code like tick-ok is said plainly, an unknown one and an exit number say nothing | yes |
| 111 | A running card says how long it may run: `run.limit_minutes` | a running card says how many minutes it may take: run.limit_minutes, from the same limit that stops it | no |
| 112 | found: a teammate's question you had answered kept saying it needed you until dismissed; your comment settles it (off needs_decision and its count, gone once quiet for a day), a reaction or a teammate's comment does not, and a follow-up question does not bring it back | a teammate's question you answered in the comments stops asking for you: a reaction or a teammate's comment does not settle it, and it is never approvable | yes |
| 113 | found: a cloud computer whose only pass was an expired mail-reading pass still listed the Atris models as ready; a missing, expired or scoped pass now reads "This computer is signed out of Atris. Sign it in again." in `feed engines`, `feed settings` and `feed members` | sign-in: no token, an expired pass and a scoped pass are signed out; a good or unreadable pass is not | yes |
| 114 | found: ten asks while signed out each used one of the day's 60 asks; a signed-out ask now skips every member with that sentence, as the answer's own `reason` too, and uses no ask | sign-in: a ping while signed out skips every member with the sentence and uses no ask of the day | yes |
| 115 | found: every failed thought read "Thought and had nothing worth your time"; a failed turn now logs "Could not think" with the reason, records a `failed` event, carries `error` (and `needs_sign_in`) on `member_done` and the result row, and gives its ask back | a failed thought says why: "Could not think", a failed event, an error to read, and the ask given back | yes |
| 116 | A failed turn is said in plain words, never a status code | a failed thought on another fault says it plainly, with no status code | no |
| 117 | Atris 2 Fast, Atris 2 Pro and Atris 2 Max are listed by name and can be any default or member model | models: Atris 2 Fast, Pro and Max are listed by name and can be the default or one member's model | no |
| 118 | found: on a business's cloud computer (no Atris sign-in there) every thought failed signed out; with `ATRIS_FEED_TURNS=caller` a cloud model turn is written to `.atris/state/feed/turns/<id>.json` and its answer read from `<id>.answer.json`, the whole answer handed on as one piece, both files removed | turns seam: the request is written in full and the answer comes back as one piece, then both files go | yes |
| 119 | An answer the caller says failed returns what the network call would: its reason, a sign-in failure read as signed out, an empty answer as no answer | turns seam: same return as the network call for a failure, a sign-in failure and an empty answer | yes |
| 120 | A caller's sign-in failure reads as signed out on the thought and gives the ask back | turns seam: a sign-in failure from the caller reads as signed out on the thought, with the ask given back | no |
| 121 | No answer in time (90 seconds, or the turn's own shorter limit; `ATRIS_FEED_TURN_WAIT_MS` overrides) says the model took too long, removes the request and gives the ask back | turns seam: no answer in time says the model took too long, removes the request and gives the ask back | yes |
| 122 | A whole thinking round under the switch makes a real card from an answer written with `atris feed turns answer` | turns: a full thinking round under the switch makes a real card from an answer written by the turns commands | yes |
| 123 | An answer sent in pieces (`--append-b64`, then `--done`) is the whole text, in any script | turns: chunked appends then done equal the whole text, including words in other scripts | yes |
| 124 | Under the switch the Atris models are ready whatever the sign-in here, and the house pick is Atris 2 Fast; without it, signed out still says signed out | turns: the Atris models are available under the switch whatever the sign-in here, and signed out without it | yes |
| 125 | `atris feed turns` lists waiting turns oldest first with no message text; show and answer refuse unknown, expired and badly named ids before touching a file | turns: list, show and answer refuse unknown, expired and badly named turns, and list shows no message text | yes |
| 126 | `thinking` stays true while a background teammate process started under the switch is alive | turns: thinking is true while a background teammate process started under the switch is alive, false once it is gone | no |
| 127 | Without the switch a cloud turn goes to the network call exactly as before | turns: without the switch a cloud turn goes to the network call as before and writes no file | yes |

## The caller makes the model call

With `ATRIS_FEED_TURNS=caller` (exactly that value) the feed never calls an Atris cloud model itself. Every turn it would send to `atris-fast`, `atris-pro` or `atris-max` (thinking, `feed talk`, `feed talk --member`, discussions and tagged replies, Atris's pick in a discussion, queued wakes, rewrites, approved work written on a cloud model, `feed doctor`) goes through one seam, `lib/feed-turns.js` `runCallerTurn`, called from `lib/feed-team.js` `runTurn`. It writes `.atris/state/feed/turns/<id>.json` and waits for `<id>.answer.json`. The caller (the website, which holds the sign-in) reads waiting turns with `atris feed turns --json` and `atris feed turns show <id> --json`, and answers with `atris feed turns answer <id> --append-b64 <text>` then `--done`, or `--failed "<sentence>" [--needs-sign-in]`. Under the switch the Atris models count as ready whatever the sign-in on this computer. Run `node --test test/feed-turns.test.js`.

## Waiting chat windows

`feed waiting set --session <id> --ask "<question>"` reports a stopped chat, with an optional window title and engine. Setting it again replaces the ask and keeps the first waiting time; `feed waiting clear --session <id>` removes it. `feed waiting list --json` lists the live entries, oldest first.

Waiting chats appear before every other card in both `all` and `needs_decision`. Answer in the original chat: deciding here is refused, passing never hides them, and they do not count as ideas. Entries older than 24 hours disappear. The feed's existing author object carries the window name in `author.name`. Entries live in `.atris/state/feed/waiting.json`, saved atomically under `waiting.lock` with the feed's retryable busy errors. Run `node --test test/feed-waiting.test.js` for the CLI, ordering, expiry, safety and simultaneous writer checks.

## Discussions that move forward and end

A teammate's reply on a card says what it is: `REPLY <n>: FOUND|IDEA|DID|DISAGREE: ...`, and Found ends with `FROM:` and where. A reply with no kind, or one that is only a question, is not saved; the reason is a `dropped` line in the feed's events. One card takes at most three team comments after the last thing a person said, nobody twice in a row, and a second comment from the same teammate only as Found or Did. A saved reply carries `kind` and, for Found, `source`.

The one who asked then closes it in its next thought, and is asked before everyone else: `OUTCOME <n>` with `ANSWER`, `NEXT`, `OWNER` (a teammate or `owner`), and optionally `LESSON`, `ASK_OWNER` and `CHOICES` (at most three, split by `|`). The card carries it as `outcome`: `{ reply_id, by, at, answer, next, owner, after, needs_you, lesson }`, null while open. `ASK_OWNER` puts the card in the owner's hands first (`owner` is the person, `after` the teammate named); the owner's reply is saved as `decided` and the card goes to that teammate. The lesson is saved as a team note (`atris feed notes`), which every teammate reads before it thinks. A closed card takes no more team comments; a person's comment opens it again. `atris feed work <card> --reply <outcome.reply_id>` starts the next step as work for the teammate named. On the owner's own post a teammate who took part may close it; a full discussion nobody closed for 30 minutes, anyone. Rules: `lib/feed-outcome.js`. Run `node --test test/feed-outcome.test.js`.

## Which model the feed runs on

With no choice made, the feed runs on Codex on this computer when it is installed and signed in, else Atris 2 Fast. The Atris models are `atris-fast` (Atris 2 Fast), `atris-pro` (Atris 2 Pro) and `atris-max` (Atris 2 Max); they need this computer signed in to Atris, and a missing, expired or scoped pass counts as signed out (`lib/sentinel-cloud.js` `modelSignIn`). The workspace's saved engine is not used. A member's roster line is used unless it names a costly model (`fable`, `claude`); then it is passed over and reported as `skipped`. A costly model runs in the feed only when a person picked it for the feed: `atris feed settings set default-engine <id>`, `atris feed settings set member-engine <member> <id|none>`, or one ask with `atris feed talk --member <name> --engine <id>`.

## The feed asking by itself

Reaching the end of the feed (`--reason scroll`) and the heartbeat are the feed asking by itself. It asks only when something changed since the team last looked: the commit the project is on, something the person did in the feed (a note, a reply, a reaction, a decision, a clear), or work that moved. The team's own notes, replies and ideas never count, so one round is never the reason for the next. A discussion waiting for its outcome is the one other reason. It starts at most 6 teammate runs an hour this way (`AUTO_RUNS_PER_HOUR` in `lib/feed-team.js`). It never wakes a teammate on an Atris model, since those cost credits and nothing spends credits unless the person asked; that teammate is skipped with the reason, and still answers a refresh, a tap for more, its name or a discussion the person started. A person asking is never held to any of these rules: `--reason more` (a tap for more, and `atris feed more`), `--reason refresh`, a member by name, or a post. A teammate still writing when the feed is cleared writes nothing: every write checks the clear stamp taken when its thought began.
