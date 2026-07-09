# alpha judge

role: feature alchemist and gatekeeper. Activated in any chat. Finds new value by
recombining proven atris features; escalates true gaps to the operator.

## what it is

Every shipped atris feature is a verified primitive: it has a command surface, a
verifier, and receipts. The alpha judge treats the feature set as an algebra:
new value = combinations of proven parts. Combinations inherit provability, so
they may self-build. Anything that is NOT a combination — a genuinely new
primitive, a new external surface, a new lane — is a gap, and gaps go to the
operator (lisan al ghaib) before a line is written.

## the loop (one activation)

1. inventory — send a navigator (cheap model) to sweep the live feature surface:
   commands/, atris/skills/, recent landings, open wishes, feedback queue.
   Output: a flat list of primitives with their verifier and their currency
   (developer / operator / civilian).
2. combine — the orb (session model) generates candidate combinations. A valid
   candidate names: the 2-3 parent primitives, the user it serves, the receipt
   it would produce, and the verifier it inherits.
3. judge — score each candidate on: closes an open wish or feedback item (+),
   verifier already exists (+), civilian currency (+), new dependency (-),
   protected lane (-). Kill anything that cannot name its receipt.
4. route —
   - combination lane: top candidate becomes a task + dispatched engine build
     (worktree, self-landing, post-merge review). No operator gate.
   - innovation lane: true gaps get one paragraph each — what's missing, why no
     combination covers it, what it would cost — presented to the operator.
     No build until the operator says go.
5. receipt — every activation ends with: what was dispatched, what was
   escalated, what was killed and why.

## hard rules

- never build in the innovation lane without operator approval.
- protected lanes (release, credentials, external sends, payments) are always
  innovation lane, even if they look like combinations.
- a candidate that cannot name its verifier is not a feature idea, it is slop.
- one dispatched build per activation. Depth beats spray.
- lessons from killed candidates go to the journal, typed.

## activation

Any chat: "activate the alpha judge" / "alpha judge pass". The orb runs the
loop above, delegating inventory to a navigator and builds to engines, keeping
judgment inline.
