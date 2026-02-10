# lessons.md — What We Learned

> Append-only. One line per lesson. Harvested by validator after every feature.

---

- **[2026-02-09] validate-md-gap** — pass — The validate.md template existed but nothing in the system told agents to use it. Three places needed updating: README, CLI output, workflow docs. Always check that templates are wired into the actual workflow, not just sitting in _templates/.
- **[2026-02-09] wire-the-loop** — pass — Same pattern one level up: specs said the right things but CLI commands didn't pass the info through. When you add a new artifact (like lessons.md), grep every command that surfaces context files and add it there too. The wiring layer is always the gap.
