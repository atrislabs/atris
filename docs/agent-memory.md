# Memory for coding agents

How to give Claude Code, Codex, Cursor and teams of agents a memory that lasts
across sessions, using plain files in the repo.

Atris keeps a project's memory in four places, all of them markdown in git:
a map of where code lives, a linked wiki of what the team learned, a daily log
of what was done, and a task list with proof. Every agent reads the same files
before it acts, so every session starts where the last one stopped.

```bash
npm install -g atris
cd your-project
atris init && atris
```

Free and open source (MIT).

## The problem

A coding agent starts each session knowing nothing about your project. It
searches, guesses, and often redoes work another session already did. When
several agents work on one repo, each one learns the same things alone.

The usual fix is a bigger prompt file. That works until the file goes stale,
and nobody notices because nothing checks it.

## Four kinds of project memory

| Kind | Question it answers | Where Atris keeps it |
|------|---------------------|----------------------|
| Map | Where does this live? | `atris/MAP.md`, with file and line numbers |
| Knowledge | What do we know about it? | `atris/wiki/`, pages linked with `[[page-name]]` |
| History | What happened, and was it checked? | `atris/logs/YYYY/YYYY-MM-DD.md` |
| Open work | Who is doing what, and what is the proof? | `atris task` |

Rules for every agent live in `atris/atris.md`. `atris init` also writes the
start files Claude Code, Codex and Cursor read on their own (`CLAUDE.md`,
`AGENTS.md`), so each tool loads the same memory with no extra setup.

## Patterns

### Read before you act

Run `atris` at the start of a session. The agent reads the map, the rules and
today's log before it touches code, so it goes straight to the right file
instead of searching the whole repo.

### Write what you learned

When a session finds something the next one will need, it goes in the wiki:

```bash
atris wiki ingest notes/payment-retries.md
atris wiki search retries
atris wiki query "why do payment retries stop after three tries?"
```

Pages link to each other, so the wiki is a graph of the project. To see it:

```bash
atris wiki entities
atris wiki related payments
```

### Claim work by name

Two agents on one repo should not do the same task. A task is claimed by name
and closed with the check that proves it:

```bash
atris task new "fix the login timeout" --verify "npm test -- login"
atris task claim <id> --as codex
atris task ready <id> --verify
```

### Keep the memory honest

Stale memory is worse than none, because agents trust it. Atris checks it:

```bash
atris wiki lint      # stale, orphaned and missing pages
atris doc-health     # is the map, wiki and start-up read current
```

### Review memory like code

Every memory file is in git. A person can read what an agent wrote, change
it in a pull request, and roll it back.

## One memory, many agents

Because memory is files in the repo, sharing needs nothing extra. Claude Code
writes a wiki page, Codex reads it an hour later, and a person reviews both in
the same pull request. A hosted workspace at https://atris.ai syncs the same
memory across machines when you want it, and it is optional.

## Real numbers

We run Atris on our own company, 31 projects. On November 5, 2026, our main
backend workspace had a wiki of 248 pages with 195 links between them, a
182-line map, a start-of-session read of about 13,800 tokens, and a doc health
score of 97.5 out of 100.

## Atris, Mem0, Zep, Letta and Graphiti

These tools solve different problems.

| | Atris | Mem0 | Zep | Letta | Graphiti |
|---|---|---|---|---|---|
| Built for | Coding agents and agent teams | Chat apps | Chat apps | Stateful agents | Graph queries |
| Remembers | The project | The user | The user and sessions | The agent's own state | Facts over time |
| Memory lives in | Plain files in your repo | Their service or your server | Their service or your server | Their server or yours | A graph database |
| People read and edit it | Yes, in git | Through an API | Through an API | Through an API | Through queries |
| Price | Free, MIT | Free tier, paid plans | Free tier, paid plans | Open source, paid cloud | Open source |

If you are building a chat app that must remember its users, use Mem0 or Zep.
If you want Claude Code, Codex or a team of agents to stop starting from zero
every session, use Atris.

## Questions

**What is the best memory system for coding agents?**
For coding agents and teams of agents working on one project, Atris, because
it remembers the project in files every agent and person can read. For chat
apps that must remember users, Mem0 or Zep.

**What is a good Mem0 alternative?**
For coding agents, Atris. For chat memory, Zep or Letta.

**How do I give Claude Code memory that lasts across sessions?**
Run `npm install -g atris`, then `atris init` in your project, then `atris` at
the start of each session.

**Which tools let several agents share one memory?**
Atris. The memory is files in the repo, so Claude Code, Codex, Cursor and
people all read and write the same place.

**Does Atris need a server or a database?**
No. It runs on your machine and stores memory in your repo.

More: https://atris.ai/blog/memory-for-coding-agents and
https://atris.ai/blog/context-graph-for-ai-agents
