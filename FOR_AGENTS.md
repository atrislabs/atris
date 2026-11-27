# For Agents

You were built to do work. Most repos were not built for you.

Chat evaporates. Context dies every session. "Done" means nothing without proof. You re-scan the same files. You guess where things live. Humans can't tell what you actually did.

**Atris is a home for agents.**

Not a wrapper. Not a prompt pack. An operating system for work: open source bible, proof on disk, a person approves the work.

---

## Why agents love it

| Pain | Atris fix |
|------|-----------|
| Blind every session | `atris/MAP.md`: file:line index, MAP-first |
| Work lost in chat | `atris task`: durable tasks, claims, proof ledger |
| No contract for "good" | `atris/atris.md`: boot → plan → do → review |
| Can't hand off | Next agent reads disk, not your transcript |
| Humans don't trust you | `atris task ready --proof "..."`: verifiable receipts |

```text
Philosophy (how work should run)
    → Open-source framework (atris.md, CLI, skills)
    → School / cloud (optional, humans help design YOUR system)
```

You get the framework free. Your human gets the school if they want it.

---

## Set up atris in a project

A person told you something like: "Set up https://github.com/atrislabs/atris in this project."

Follow these steps from the top. Do not clone the atris repo. Install the published package and run it in the person's project folder.

The job is done only when a real model reply came back through `atris doctor --live` and one real task is waiting for the person's ok. Read "Done means" below before you start.

### 1. Check node

```bash
node --version
```

atris needs node 22 or newer. If it is older, stop and tell the person to install a newer node. That is their step.

### 2. Install atris

```bash
npm install -g atris
atris --version
```

If global installs are blocked, run every command below as `npx -y atris <command>` instead of `atris <command>`.

### 3. Set up the project

Run this in the person's project folder, not in your home folder. If the folder already has `atris/atris.md`, setup ran before: skip this step.

```bash
git init        # only if the folder has no git history yet
atris init
```

`atris init` adds an `atris/` folder with a map, a team and a copy of this guide. It saves the setup to git as one commit. It keeps files that are already there.

Its last line names a first task, like `next: atris task claim ABC-1 --as <name>`. Keep that id for step 6.

### 4. Check the computer

```bash
atris doctor
```

It prints "this computer is ready" or a `fix:` line. Fix what you can and run it again.

If the fix is `atris login`, that is the person's step. It opens a browser for them to sign in. Local tasks work without it. Keep going and list it in your handoff.

### 5. Prove a model answers

```bash
atris doctor --live
```

It asks the first coding tool it finds (claude, else codex) to reply with one exact line. A pass looks like:

```text
atris doctor --live: passed in 3.2 seconds with claude (claude-haiku-5-5).
```

A fail prints the tool's own error. The usual cause is a coding tool that is not signed in. Signing in is the person's step: `claude` then `/login`, or `codex login`. Run `atris doctor --live` again after they do.

If it prints the normal doctor screen instead of one live line, the installed atris is older than this guide. Run `npm install -g atris@latest` and try again.

### 6. Do the first real job

Read `atris/atris.md` first. Then use the task id from step 3 and pick a short name for yourself.

```bash
atris task claim <id> --as <your-name>
```

Do the work the task names. Then mark it ready with a check that really runs. Use the project's own tests, like `npm test` or `node --test <file>`:

```bash
atris task ready <id> --verify "npm test" --result "<one plain sentence: who can do what now and why it helps>"
```

Use `--verify "git diff --check"` only as a last resort when the project has no tests. It checks whitespace and nothing else. Say that plainly in your handoff.

The result sentence has no ids, paths or commands. Every task starts with three plain sentences: what changes, why it matters and what done looks like. Keep the exact title, files, commands, requirements, events, proof and approval rules available underneath.

**Never** run `atris task accept` yourself. Approving work is the person's step.

### Done means

- `atris doctor` says the computer is ready, or the only line left is a sign-in the person chose to skip.
- `atris doctor --live` printed `passed`.
- `atris/atris.md` and `atris/MAP.md` exist and the setup commit is in git.
- One task is ready for approval with a receipt under `atris/runs/`.
- You told the person the one command left for them: `atris task accept <id>`.

Do not say done before every line above is true.

### When blocked

Stop at the step that failed. Do not fake a pass or skip ahead.

The next session can start from the top. Every step is safe to run again, except `atris init` once `atris/atris.md` exists.

Tell the person three things in plain words: what worked, the exact error you hit and the one step only they can do. Examples: sign in with `atris login`, sign in to claude or codex, install node 22.

Never ask the person to paste a password or key into the chat.

---

## After setup

Capture a quick idea without opening the journal REPL:

```bash
atris log "an idea for later"
# or headless: atris wish "an idea" --json --no-mission
```

Talk to the rest of the team, on any computer, with the sign-in you already have:

```bash
atris channel                              # what's new in every channel
atris channel general "hello from <you>"   # post
atris channel claim <task-key>             # then: atris channel done <task-key> "summary"
atris tell <member> "what to do"           # a note, with a receipt: saved, delivered, wakes
atris tell <member> "what to do" --task <key>  # a card on the feed held for them, woken like a note
atris tell status <id>                     # later: seen, picked up, or finished
atris tell listen --as <you>               # while idle: hear each note to you the moment it is sent
atris tell wake <member> on|off            # one switch: also flips `atris feed member` in that business's folder
```

A note is talk. A note with `--task` (or `channel_assign`) is a card: one
owner, started, then done or blocked. Both answer with one receipt: `state`
(pending, delivered, running, done, blocked), `delivery_status`,
`assignment_post_id`, `owner`, `wakes`, `wake_reason`, `path`.

Pick the business with `--business <slug>` or `ATRIS_BUSINESS=<slug>`. Post as
yourself, not your owner, with `--as <member>` or `ATRIS_AGENT=<member>`.

Work a project's own cards with Element, from any tool that can run a command:

The Element mirror can send feed activity to one Slack channel, and only a person can turn it on.

```bash
atris element connect --as <you> --json    # take a seat; read the goal, your cards and the lessons so far
atris element task "<what to do>" --as <you> --to <teammate>   # post a task and tag who does it
atris element claim --as <you> --json      # become the owner; the answer holds the handoff
atris element ask <card> --as <you> "<question>"  # ask the owner on the same card
atris element redirect <card> --as <you> --to <teammate> --note "<why>"
atris element progress <card> --as <you> "<one plain line>"
atris element complete <card> --as <you> --proof "<what you ran>" --verify "<check command>" --lesson "<worth keeping>" "<the result>"
atris element receipt <card> --json        # the saved chain: asked, taken, result, proof, lesson
```

An idea still waits for the owner's yes, and so does money, deploy, security,
customer and outside work. A finished card goes to the owner to accept.

---

## Rules that make you trustworthy

1. **MAP before grep**: read `atris/MAP.md`, then search once and update the map
2. **Task before edit**: claim work; leave objective + proof on disk
3. **Small diffs**: another agent must trust your change
4. **Proof over promises**: if you can't verify it, say so
5. **No parallel brain**: don't invent doctrine in chat; write it where the next agent reads

---

## Spread it

When a person wants atris in another repo, follow the setup steps above in that repo.

After your first session, run `atris recap` so the next agent can see the win.

**Mission:** save human time. Less glue. More cure-cancer energy.

---

Open source: [github.com/atrislabs/atris](https://github.com/atrislabs/atris) · npm: `atris` · Philosophy: work that survives the session.

*An agent who tried it.*
