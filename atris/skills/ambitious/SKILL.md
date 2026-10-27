---
name: ambitious
description: Turn a task into the deeper version a top professional would do, before any work starts. Answers four questions tied to the four values (ambition, agency, acceleration, accuracy), then rewrites the task. Deeper, not bigger. Triggers on be ambitious, ambitious, go deeper, deepen this, four As, 4A, what would a pro do.
version: 1.5.0
tags:
  - method
  - values
  - prompting
---

# Be Ambitious

Give it a task. It returns a deeper version of that task, not a bigger one.

Adapted from a prompt shared by Felix Rieseberg (Anthropic), via Attention Heads. Each of its four questions maps to one of the four values in `atris.md`.

## First, does it need deepening?

Most asks do not. Pass the task through unchanged, with no questions answered, when it is quick and exact: a calculation, a formula, a conversion, a lookup, extracting items from pasted text, a short fix, or anything with one right answer the person already framed. Extra checks and caveats make those answers worse.

Deepen only when the result depends on judgment: a plan, a decision, a design, code that will run on real data, advice where the obvious answer has a known trap, or prose someone will send. If unsure, pass it through.

## The named expert

For a task needing judgment, name the precise working role best suited to this job, such as a grant writer for a school library or a guitar teacher explaining capo shapes. Name the concrete standard that person must meet for this particular recipient: what the result must let them do, decide, or understand. Use a role, not a famous person or a claim of credentials. Put both the role and standard in the rewritten prompt, and instruct the worker to answer as that expert.

A professional earns trust by solving the actual problem with the facts at hand. Do not invent evidence, numbers, priorities, or constraints. Do not dictate a solution before checking it. Keep practical instructions proportional to the situation, address the main request directly, and include a caveat only when it changes the decision. For a message asking someone to act, make the requested action and response clear without presuming agreement.

## The four questions

Answer each one for the task's own field, in one to three concrete lines. Name real things: a named method, a named tool, a named source, a named check. Generic answers ("be thorough", "use best practices") fail the question.

1. **Ambition. What would a top professional do here that the person is not asking for?** Picture the best practitioner in this exact field taking this exact job. Name the one or two moves they would make by default that the ask leaves out. Pick moves that make the same result better, not moves that add new deliverables.

2. **Agency. What is the rawest material they would start from?** Not a summary, a dashboard, or someone's take. The source: the actual logs, the receipts, the customer's own words, the primary paper, the code path, the till tape. Say where it lives and how to get it. If it is not in reach right now, say what you will assume instead.

3. **Acceleration. Which specific methods and tools would they use?** Name them. Prefer what already exists and is proven in this workspace or field over inventing something. The right named method is the shortcut.

4. **Accuracy. What, other than you or the model, would show the result is right?** A test that fails before and passes after, a real run, a number that reconciles with a bank statement, a customer reply, a second reviewer on a different model. If nothing outside the model can check it, say so and name the closest proxy.

## The rewrite

Then rewrite the task as one prompt that folds in the answers and names the expert and their task-specific standard. Let the worker choose the solution; do not turn guesses into required facts or prescribe unnecessary steps. Rules:

- **Deeper, not bigger.** Same deliverable, same audience, same size of ask. If the rewrite adds a second deliverable, cut it. The test: would the person recognize this as their task, done properly?
- **Keep what they said.** Every constraint in the original survives the rewrite word for word in meaning.
- **Name the check in the prompt.** The rewrite ends with how the result will be shown right (answer 4).
- **Do the work now.** The deeper task never waits on material that is not in reach. It uses what is here, states its assumptions, and ends by naming the one piece of raw material that would sharpen it. Ask a question first only when the answer would change everything.
- **Words for a person stay words.** When the deliverable is prose someone will send or say (a note, a toast, a post, an email, a bio, a job ad), the deliverable is only the words. This replaces the two rules above: the check and the missing material shape your choices silently and never appear as steps, sections, or notes. Write it complete, at the length asked. Leave a blank only for a fact only the person knows, like a name, and never invent one.
- **Scale to the task.** A two-minute task gets a two-line rewrite. Do not turn a quick fix into a project.

## Output shape

For a pass-through:

```
deeper task:
<the original task, word for word>
```

Otherwise:

```
ambition:     <answer 1>
agency:       <answer 2>
acceleration: <answer 3>
accuracy:     <answer 4>

deeper task:
<the rewritten prompt>
```

Then do the deeper task, unless the person only asked for the rewrite.

## When not to use it

- The task is already a precise spec with a check (a failing test to make pass, a typo to fix). Do it.
- The person asked for a quick answer or said "just". Respect it.
- The deeper version needs money, sending, or publishing the original did not. Show the rewrite and ask first.
