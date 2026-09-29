'use strict';

// MEMBER.md `type:` says who a member is. Missing means ai and `agent` is an
// alias for ai. `human` is a person: Atris can prepare work for them but never
// acts as them. Any other value keeps the file readable but is never run.

function memberTypeOf(frontmatter) {
  const raw = frontmatter && frontmatter.type;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { type: 'ai', raw: '', runnable: true };
  const lowered = value.toLowerCase();
  if (lowered === 'ai' || lowered === 'agent') return { type: 'ai', raw: value, runnable: true };
  if (lowered === 'human') return { type: 'human', raw: value, runnable: false };
  return { type: 'other', raw: value, runnable: false };
}

// Plain sentence for why a member will not run; '' when it can run.
function memberRefusalReason(name, frontmatter) {
  const info = memberTypeOf(frontmatter);
  if (info.runnable) return '';
  if (info.type === 'human') {
    return `${name} is a person, not an AI teammate; Atris can prepare work for them but cannot act as them`;
  }
  return `${name} has type '${info.raw}', which is neither ai nor human, so Atris won't run it`;
}

module.exports = { memberTypeOf, memberRefusalReason };
