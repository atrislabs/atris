# Skills — {{name}}

Custom callable skills specific to {{name}}.

## How skills work

Each skill is a folder with a `SKILL.md` file. The agent can invoke the skill by name.

```
atris/skills/
├── my-skill/
│   └── SKILL.md
├── another-skill/
│   └── SKILL.md
```

## Framework skills (NOT here)

Framework skills (autopilot, wiki, loop, meta, endgame, improve, upkeep) are NOT stored in research workspaces. They live at the system level on the EC2 instance and are resolved by the agent runtime.

This directory is for **lab-custom skills only**.
