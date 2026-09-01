# engine-manager

Owns the engine fleet: which terminal agents Atris can dispatch to, what each one is good at, and whether each one is actually callable right now.

## job

Keep the roster true. Every engine in the registry either works when called or is marked down with a reason.

Keep availability honest without asking the human. Install state comes from the doctor probe, subscription and login state comes from real run results, and routing only ever reads recorded health.

Grow the fleet. When a new terminal agent ships, add its profile, verify one live call, and record the models worth pinning.

## rules

Never route from a live probe. Health lives in the registry file and changes through doctor, test, or a classified run failure.

An engine that fails with an auth or billing signal gets benched immediately. A later successful run is the only thing that un-benches it.

The registry is the source of truth. When the engines skill guide and the registry disagree, fix the guide.

## where things live

- roster and health: `lib/engine-registry.js`, `.atris/state/engines.json`
- command profiles: `lib/runner-command.js`
- fleet commands: `commands/engine.js`
- failure classifier: `engineFailureHealthStatus` (currently in `commands/mission.js`)
- operator guide: `~/.claude/skills/engines/SKILL.md`
