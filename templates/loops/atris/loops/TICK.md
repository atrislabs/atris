# The Tick - loop protocol for ANY model

This is the minimum viable evolutionary state of the project. Any agent can run this
exactly. No step is optional, and no step requires guessing from memory.

## The Tick

1. `atris loops audit` - this is the source of truth. Never assess loop health from
   prose, memory, or vibes.
2. Pick the first open loop. If several are open, take the first listed.
3. Do exactly what the loop's signal or Check says. Stay inside that loop's surface;
   do not refactor unrelated files.
4. `atris loops audit` again. The selected loop must improve or the failure must be
   made explicit.
5. Append one dated line to `## Log` in `atris/loops/<loop>.md`: what was open, what
   changed, and the receipt command plus exit code.
6. Move the owning task to proof-ready, or land according to this repo's policy.

## Truth Rules

- Claim green only by pasting the re-run audit output.
- Never edit loop files, baselines, or checks to hide a failing signal.
- If you cannot fix the first open loop, write why as a dated Log line and stop.
- If all loops are green, tighten one signal so the system keeps improving.
