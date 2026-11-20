# Set up atris

This guide is for a coding agent. A person told you something like:
"Set up https://github.com/atrislabs/atris in this project."

Follow it from the top. Do not clone the atris repo. You install the published package and run it in the person's project folder.

The job is done only when a real model reply came back through `atris doctor --live` and one real task is waiting for the person's ok. Read "Done means" at the end before you start.

## 1. Check node

```bash
node --version
```

atris needs node 22 or newer. If it is older, stop and tell the person to install a newer node. That is their step.

## 2. Install atris

```bash
npm install -g atris
atris --version
```

If global installs are blocked, run every command below as `npx -y atris <command>` instead of `atris <command>`.

## 3. Set up the project

Run this in the person's project folder, not in your home folder.

```bash
git init        # only if the folder has no git history yet
atris init
```

`atris init` adds an `atris/` folder with a map, a team and this guide as `atris/SETUP.md`. It saves the setup to git as one commit. It keeps files that are already there. If the folder already has `atris/atris.md`, setup ran before: skip `atris init`.

Its last line names a first task, like `next: atris task claim ABC-1 --as <name>`. Keep that id for step 6.

## 4. Check the computer

```bash
atris doctor
```

It prints "this computer is ready" or a `fix:` line. Fix what you can and run it again.

If the fix is `atris login`, that is the person's step. It opens a browser for them to sign in. Local tasks work without it. Keep going and list it in your handoff.

## 5. Prove a model answers

```bash
atris doctor --live
```

It asks the first coding tool it finds (claude, else codex) to reply with one exact line. A pass looks like:

```text
atris doctor --live: passed in 3.2 seconds with claude (claude-haiku-5-5).
```

A fail prints the tool's own error. The usual cause is a coding tool that is not signed in. Signing in is the person's step: `claude` then `/login`, or `codex login`. Run `atris doctor --live` again after they do.

If it prints the normal doctor screen instead of one live line, the installed atris is older than this guide. Run `npm install -g atris@latest` and try again.

## 6. Do the first real job

Use the task id from step 3. Pick a short name for yourself.

```bash
atris task claim <id> --as <your-name>
```

Do the work the task names. Then mark it ready with a check that really runs:

```bash
atris task ready <id> --verify "git diff --check" --result "<one plain sentence: who can do what now and why it helps>"
```

The result sentence has no ids, paths or commands. If the project has tests, verify with them instead of `git diff --check`.

Do not accept the task yourself. Approving work is the person's step.

## Done means

- `atris doctor` says the computer is ready, or the only line left is a sign-in the person chose to skip.
- `atris doctor --live` printed `passed`.
- `atris/SETUP.md` and `atris/MAP.md` exist and the setup commit is in git.
- One task is ready for approval with a receipt under `atris/runs/`.
- You told the person the one command left for them: `atris task accept <id>`.

Do not say done before every line above is true.

## When blocked

Stop at the step that failed. Do not fake a pass or skip ahead.

The next session can start from the top. Every step is safe to run again, except `atris init` once `atris/atris.md` exists.

Tell the person three things in plain words: what worked, the exact error you hit and the one step only they can do. Examples: sign in with `atris login`, sign in to claude or codex, install node 22.

Never ask the person to paste a password or key into the chat.
