# The wish process

You say what you want. The system does the rest and shows you proof.

That is the whole idea. This page explains what happens between the
sentence you type and the finished work, in plain words.

## Making a wish

```
atris wish "get every overdue invoice chased this week"
```

Messy is fine. A wish is a want, not a spec. You never fill out a form.

## What happens next

1. **The wish is read.** The system restates it as one concrete outcome.
   If something is genuinely unclear, you get one question back, never a
   questionnaire. Answer with `atris wish grant`.

2. **It becomes a mission.** A mission is the wish with a finish line:
   what done looks like and how it will be proven.

3. **The mission breaks into tasks.** Small pieces of work, each with its
   own check. Tasks are claimed by workers so nothing is done twice.

4. **A worker builds it.** The system picks the right worker for the job.
   You can force a choice with `--engine` if you care; most people never
   will.

5. **The work is verified.** A check runs before anything counts as done.
   Work that fails the check does not ship.

6. **You get a receipt.** What was done, where it lives, and the proof it
   works. Everything is written to files you can open and read: wishes,
   missions, tasks, and results all live on disk in the atris folder.

## Reviewing

After you see the result, say one sentence:

```
atris wish review latest "that nailed it"
atris wish review latest "asked too many questions"
```

Reviews are how the system learns your taste. Review the good ones too,
not just the failures. Over time the wishes get granted the way you would
have granted them.

## Who you are changes the ride

- **Operator** (most people): wish, wait, review. That is the whole job.
- **Orb / orchestrator**: your wishes fan out to workers and come back as
  receipts.
- **Builder**: you can take a wish and build it yourself directly; the
  wish still gets a mission, a check, and a receipt like everything else.

## Checking on things

```
atris wish            # your open wishes
atris mission status  # the live board
```

Everything above is a file. Nothing is hidden in a database you cannot
read. That is deliberate: the folder is the company's memory, and anyone
on the team can open it.
