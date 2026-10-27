---
name: ambitious
description: Turn a task into the deeper version a top professional would do, before any work starts. Answers four questions tied to the four values (ambition, agency, acceleration, accuracy), then rewrites the task. Deeper, not bigger. Triggers on be ambitious, ambitious, go deeper, deepen this, four As, 4A, what would a pro do.
version: 1.4.0
tags:
  - method
  - values
  - prompting
---

# Be Ambitious

Give it a task. It returns a deeper version of that task, not a bigger one.

Adapted from a prompt shared by Felix Rieseberg (Anthropic), via Attention Heads. Each of its four questions maps to one of the four values in `atris.md`.

## First, does it need deepening?

Default to passing the original task through word for word. This includes quick and exact asks, ordinary instructions, practical advice, writing, plans, and code. A competent answer can supply normal judgment without a rewrite.

Deepen only if you can identify a specific omission in this particular ask that is likely to cause a materially wrong or unusable result, and can name a small, concrete instruction that prevents it. Do not deepen for a merely possible improvement, an unspecified best practice, or a concern the worker can handle normally. If unsure, pass through. Never change a quick exact ask.

## The four questions

For a task that passes that threshold, answer each in one short line. Use only what is relevant to this particular omission. Say "none needed" when a question has no useful answer. Do not invent facts, data, sources, methods, constraints, or requirements.

1. **Ambition:** What specific omission could make the requested result wrong or unusable? How can it be addressed within the same deliverable?
2. **Agency:** Is a particular available source essential? If unavailable, what assumption or limitation is necessary?
3. **Acceleration:** Is there a specific method needed to address the omission? If not, leave it to the worker.
4. **Accuracy:** Is there a specific check that would catch the error? If so, make it proportionate and use it silently when possible.

## The rewrite

Keep the entire original request and its constraints. Add only the smallest instruction needed to address the identified omission. Keep the same deliverable, audience, and size. Do not prescribe an answer, add a schedule or other deliverable, demand missing materials, invent details, or mandate a check or source when it does not help. Do the work with the information available; state a material assumption only where needed. For prose meant to be sent or spoken, return only the requested words. If no small addition clearly helps, pass the original through unchanged.

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
