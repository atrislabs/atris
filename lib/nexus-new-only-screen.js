'use strict';

// Ask the signed-in owner's connected Google services once. Only a complete,
// recognized answer can authorize the caller to try a new-only capture.
async function screenNewProspect({ request, token, name, email }) {
  if (!token || typeof name !== 'string' || !name.trim()) return { status: 'unavailable' };
  let response;
  try {
    response = await request('/integrations/google/known-person', {
      method: 'POST',
      token,
      body: { name, ...(email ? { email } : {}) },
      timeoutMs: 45_000,
      retries: 0,
    });
  } catch {
    return { status: 'unavailable' };
  }
  if (!response?.ok) return { status: 'unavailable' };
  const { status, checked, contacts_scope: scope } = response.data || {};
  if (!['matched', 'clear', 'unavailable'].includes(status) || !['connected', 'not_connected'].includes(scope)) {
    return { status: 'unavailable' };
  }
  const counts = ['gmail', 'calendar', 'contacts'].map((source) => checked?.[source]);
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) return { status: 'unavailable' };
  if (scope === 'not_connected' && checked.contacts !== 0) return { status: 'unavailable' };
  if (status !== 'unavailable' && !counts.some((count) => count > 0)) return { status: 'unavailable' };
  if (status === 'clear' && scope === 'connected' && checked.contacts === 0) return { status: 'unavailable' };
  return { status, checked: { gmail: checked.gmail, calendar: checked.calendar, contacts: checked.contacts }, contacts_scope: scope };
}

module.exports = { screenNewProspect };
