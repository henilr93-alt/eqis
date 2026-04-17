const { callClaude } = require('../utils/tokenOptimizer');
const settings = require('../config/settings');
const logger = require('../utils/logger');

const SYSTEM_PROMPT = `Select the most valuable user sessions to deep-analyze.

Priority: TIER 1: errorCount>=2, rageClicks+errors, duration>300s without payment.
TIER 2: hotel pages, mobile, <30s abandonment, high pageCount.
TIER 3: any errors, longest sessions.

Return JSON array of ${settings.ZIPY_SESSIONS_TO_DEEP_ANALYZE} objects:
[{"sessionId": string, "sessionUrl": string, "selectionTier": 1|2|3, "reason": string, "watchFocus": string}]`;

async function pick(allSessions) {
  logger.info(`[SELECTOR] Picking ${settings.ZIPY_SESSIONS_TO_DEEP_ANALYZE} from ${allSessions.length}...`);

  if (allSessions.length === 0) {
    logger.warn('[SELECTOR] No sessions to select from');
    return [];
  }

  const selected = await callClaude({
    system: SYSTEM_PROMPT,
    userText: JSON.stringify(allSessions),
    mode: 'DEEP',
    label: 'zipy/sessionSelector',
  });

  if (selected && Array.isArray(selected)) {
    logger.info(`[SELECTOR] Selected ${selected.length} sessions`);
    for (const s of selected) {
      logger.info(`  Tier ${s.selectionTier}: ${s.sessionId} — ${s.reason}`);
    }
    return selected;
  }

  // Fallback
  logger.warn('[SELECTOR] AI selection failed — falling back to error count sort');
  return allSessions
    .sort((a, b) => (b.errorCount || 0) - (a.errorCount || 0))
    .slice(0, settings.ZIPY_SESSIONS_TO_DEEP_ANALYZE)
    .map(s => ({
      sessionId: s.sessionId, sessionUrl: s.sessionUrl,
      selectionTier: 3, reason: 'Fallback by error count', watchFocus: 'General error review',
    }));
}

module.exports = { pick };
