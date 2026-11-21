const CHANNEL = 'wechat-mini-subscribe';
const MAX_LEAD_TIME = 15 * 86400000;

function level({ state, due }, today) {
  if (state !== 'pending' || !due) return null;
  // Both inputs are Shanghai calendar dates. UTC arithmetic counts day boundaries.
  const remaining = Date.parse(due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z');
  if (remaining < 0) return 'overdue';
  return remaining <= MAX_LEAD_TIME ? 'due-soon' : null;
}

/** @typedef {{ownerId: string, templateId: string, status: 'unknown' | 'accepted' | 'declined' | 'unavailable'}} PurchaseReminderSubscription */

// A future worker checks an owner/template subscription before sending. The
// versioned due date allows a new reminder when the company reschedules.
function plan(ownerId, projectId, purchase, today) {
  const priority = level(purchase, today);
  if (!priority) return null;
  return {
    channel: CHANNEL,
    ownerId,
    projectId,
    purchaseId: purchase.id,
    due: purchase.due,
    priority,
    dedupeKey: JSON.stringify([CHANNEL, ownerId, projectId, purchase.id, purchase.due, priority]),
  };
}

module.exports = { level, plan };
