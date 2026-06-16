# Program

Target: the Atris kernel system prompt (`system_prompt.txt`).

Question: does compressing the 22-section "Atris Kernel v1" to its behavioral
spine actually improve the prompt, or just feel leaner?

Metric (`measure.py`, deterministic — a gameable proxy, not a quality oracle):
`score = gate x spine_coverage x discipline`, range 0..1, higher is better.
- spine_coverage = fraction of 7 behavioral markers present (core loop,
  authority tiers, task schema, preflight/falsifiable verifier, receipts,
  failure smells, heartbeat).
- discipline = mean of brevity, low-aspiration, low-caps, has-precedence,
  no-roadmap-bloat, no-psychoanalysis.
- gate = 0.2 when any spine marker is missing. So you CANNOT win by deleting
  the spine to look lean — that is the guard.

Keep rule: keep a proposal only if the score strictly improves.

This is a cheap proxy for the real backend A/B on atris2-fast, not a
replacement. It catches bloat and gutting regressions before a model ever runs.

Run:
  python3 reset.py
  python3 loop.py --proposal proposals/gut_spine.py --proposal proposals/spine_kernel.py
