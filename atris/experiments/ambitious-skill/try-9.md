# Try 9: gentle touch

Default to the original ask, including ordinary advice, plans, writing, and code. Deepen only when a specific omission is likely to make the result materially wrong or unusable, and add only a small instruction that addresses it.

| Version | Skill vs plain: wins, losses, ties | Skill scope growth |
| --- | --- | --- |
| 1 | 12, 14, 4 | 0 of 30 |

The skill passed 28 of 30 tasks through word for word. This practice result did not beat plain, and pass-through answers are fresh model samples, not copies of the baseline. Losses on `capo-chord-shift`, `kayak-buy-vs-rent`, `oncall-rotation-design`, `pool-shock-dose`, `tire-psi-conversion`, and `trail-hike-hydration` included incorrect details or inconsistent calculations despite unchanged prompts. `cast-iron-rust-restore`, `emergency-fund-months`, `kid-carpool-rota`, `logo-placement`, `piano-schedule-change`, and `wedding-best-man-toast` lost on practical guidance, completeness, or tone. The two deepened losses, `fence-post-picket-count` and `photo-shoot-quote`, still showed inconsistent counts or missed costs. Passing more through kept scope down but did not reliably improve answer quality.

The supplied baseline used `AMB_TOOLS=Bash,Read,Write,Edit`, although the example command defaults to no tools. An initial run without that setting replaced the cached baseline; its incomplete judgments were discarded by restoring the supplied records. The scored run used the matching tools setting so plain and nudge answers and their verdicts were reused.

Commands run from this directory:

```sh
env -u ANTHROPIC_API_KEY AMB_TASKS=practice.json AMB_OUT=out-practice AMB_PARALLEL=2 AMB_TOOLS=Bash,Read,Write,Edit node run.js
AMB_OUT=out-practice AMB_PARALLEL=2 node judge.js
```

Both exited 0. Judge summary: `skill vs plain: skill 12, plain 14, tie 4 (splits 4)` and `skill: scope growth flagged on 0/30 tasks, median words 244`.
