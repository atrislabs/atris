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
| 43 | A member's own model, else the feed default, else the workspace default | settings: a member's own roster line, else the feed default, else the workspace default | yes |
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
| 60 | Scrolling asks up to three ON members, with the person's taste | more: a scroll ping to up to three ON members, with the person's taste in their brief | yes |
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
| 74 | found: at the end of the feed with 9 ideas waiting (most held back) no new ideas came; asking for more is now always heard | found: at the end of the feed with many ideas waiting (most held back), asking for more is always heard | yes |
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
| 86 | found: after a few rounds the end of the feed said the team was resting; thirty asks in a row each bring new cards | found: thirty asks in a row with two awake members, passing every idea, each bring a new card | yes |
| 87 | found: scrolling past counted as a rejection and rested every member; now only dismissals lower a member's turn | found: scrolling past is not a no; dismissals only move a member down the line | yes |
| 88 | found: the per-member gap refused whole asks; the ask now waits a few seconds or asks someone else | limits: generous on this computer's models, tighter on paid ones, with a plain reason and when it resets | yes |
| 89 | found: the waiting cap silenced members; scrolled-past ideas no longer count and the oldest make room | found: a member at its waiting cap retires its oldest scrolled-past ideas instead of falling silent | yes |
| 90 | found: a member's own daily emit cap dropped every idea after 30; asked-for ideas follow the day's ask limit | found: ideas from an ask are held to the day's limit, not the member's own daily emit cap | yes |
| 91 | An ask whose thinker crashed or ran long clears, and the next ask goes ahead | found: an ask whose thinker crashed clears, and the next ask goes ahead | yes |
| 92 | The end of the feed rests only for the day's limit or nobody awake, with a plain reason | found: the end of the feed rests only for the day's limit or nobody awake, each with its plain reason | yes |
| 93 | An empty round tries once more for different ideas and says plainly if still empty | stream: a card cut off mid-way, or one that fails the checks, is dropped and nothing half-made is created | yes |
