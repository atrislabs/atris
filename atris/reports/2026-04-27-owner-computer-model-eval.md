# Owner -> Computer Model Eval — 2026-04-27

## Goal

Validate that future agents can recover the Owner -> Computer product model from workspace memory files without conversation context.

## Files Updated Before Eval

- `atris/MAP.md`
- `atris/TODO.md`
- `atris/wiki/concepts/owner-computer-model.md`
- `atris/wiki/systems/atris-business.md`
- `atris/wiki/index.md`
- `atris/wiki/log.md`

## Trial Results

### Trial 1 — CLI-only files

Input files:

- `atris/MAP.md`
- `atris/wiki/concepts/owner-computer-model.md`
- `atris/TODO.md`

Result: pass.

The agent recovered:

- `Owner = User | Business`
- owners have many computers
- computer = workspace + files + tools + secrets + memory + agents + validation/RL loop
- do not add a third owner type yet
- queued CLI task T113: expose the model in public CLI surfaces without schema changes

### Trial 2 — Backend-only files

Input files:

- `/Users/keshavrao/arena/atrisos-backend/atris/MAP.md`
- `/Users/keshavrao/arena/atrisos-backend/atris/wiki/concepts/owner-computer-model.md`
- `/Users/keshavrao/arena/atrisos-backend/atris/TODO.md`
- `/Users/keshavrao/arena/atrisos-backend/atris/wiki/ai-computer.md`

Result: pass.

The agent recovered:

- same owner/computer primitive
- keep personal and business computers on the same runtime
- owner boundary changes permissions, billing, secrets, and sharing
- do not split lab/community/project/collective into new owner tables yet
- queued backend guardrail `owner-computer-T1`

### Trial 3 — MAP-only cross-repo comparison

Input files:

- `/Users/keshavrao/arena/atris-cli/atris/MAP.md`
- `/Users/keshavrao/arena/atrisos-backend/atris/MAP.md`

Result: pass.

The agent recovered:

- CLI repo = public product language
- backend repo = schema guardrails
- both repos share the same ontology
- public language can vary while backend schema stays narrow and stable

### Trial 4 — Public CLI surfaces

Input files:

- `README.md`
- `bin/atris.js`
- `commands/computer.js`

Result: pass.

The agent recovered:

- `Owner = User | Business`
- each owner can have many computers
- `atris computer` is the public command for the persistent computer surface
- `atris business init "Name"` creates a shared owner plus its first/default computer
- the scaffold includes `.atris/business.json`, `.atris/state/`, and the local `atris/` workspace

## Score

4 / 4 trials passed.

## Conclusion

The model is now legible from file paths alone.
This is a self-improvement win because future agents should preserve the business/user owner model and add typed computers without fragmenting the schema.
