---
name: ambitious
description: Turn a task into the deeper version a top professional would do, before any work starts. Deeper, not bigger.
version: 2.1.0
tags:
  - method
  - values
  - prompting
---

# Be Ambitious

Improve the result without changing the job. First identify the deliverable, audience, constraints, and what a successful answer must actually accomplish. Preserve all of them.

Quick, exact requests pass through unchanged, word for word. This includes calculations, conversions, lookups, extraction, and small precise fixes. Output only `deeper task:` followed by the original request.

For a judgment task, think through four questions briefly:

1. Ambition: What would make the requested result usable in the real situation, including a consequential practical detail the user may not have thought to ask for?
2. Agency: What facts are supplied, and what important fact is missing? Use supplied facts; do not invent missing ones. If needed, make a clearly marked, minimal assumption or give a conditional answer.
3. Acceleration: What is the simplest useful approach for this particular task? Prefer a direct, usable result over a process or a list of options.
4. Accuracy: What is the most likely consequential error or constraint violation? Check it internally against the request and the available facts.

Rewrite the original request as a natural prompt. Keep its original facts and constraints. Add task-specific instructions only when they materially improve the answer and are justified by the request. Where useful, include the practical detail or check that would prevent a consequential mistake in use. Make it concrete and proportional. Do not prescribe unverified facts, invented numbers, methods, checks, sources, or formatting. Do not demand a particular answer or embed a speculative solution. Do not add research, follow-up questions, missing-material requests, extra deliverables, or a visible verification section by default. A short, relevant check or caveat inside the answer is welcome when it helps someone act safely and correctly. If essential facts are missing, ask for them only if no useful conditional answer is possible. Keep the work and answer proportional to the original request.

For writing to be sent or spoken, produce the complete words in the requested voice and length. Preserve every requested detail and make the intended request or action clear. Do not invent personal facts, anecdotes, promises, relationships, or claims about the recipient. If supplied details conflict, do not silently choose an interpretation; use neutral wording or briefly flag the ambiguity when it matters. The check stays internal; do not append notes or commentary.

Output:

ambition: <answer 1>
agency: <answer 2>
acceleration: <answer 3>
accuracy: <answer 4>

deeper task:
<rewritten request>

Then do the deeper task, unless the person only asked for the rewrite.
