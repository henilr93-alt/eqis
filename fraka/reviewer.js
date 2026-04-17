// FRAKA hourly reviewer — runs deep analysis via Sonnet.
// Produces a structured review, posts to both chat histories, persists critical alerts.

const fs = require('fs');
const path = require('path');
const settings = require('../config/settings');
const logger = require('../utils/logger');
const { callClaude } = require('../utils/tokenOptimizer');
const { FRAKA_REVIEW_PROMPT } = require('./systemPrompt');
const conversationStore = require('./conversationStore');
const proposalsStore = require('./proposalsStore');

const { getSystemStatus } = require('./tools/systemStatus');
const { readMetrics } = require('./tools/readMetrics');
const { readReports } = require('./tools/readReports');
const { budgetCheck } = require('./tools/budgetCheck');
const { listProposals } = require('./tools/listProposals');
const { getRecentFeedback } = require('./tools/techFeedback');

const FRAKA_STATE_PATH = path.join(__dirname, '..', 'state', 'fraka', 'frakaState.json');

function readFrakaState() {
  try { return JSON.parse(fs.readFileSync(FRAKA_STATE_PATH, 'utf-8')); } catch { return {}; }
}

function writeFrakaState(state) {
  fs.writeFileSync(FRAKA_STATE_PATH, JSON.stringify(state, null, 2));
}

function isFrakaAwake() {
  const state = readFrakaState();
  // Default is ASLEEP — EQIS must be woken explicitly.
  return state.active === true;
}

/**
 * Run one full hourly review. Returns the parsed review object.
 */
async function runHourlyReview() {
  if (!isFrakaAwake()) {
    logger.info('[FRAKA] Hourly review skipped — FRAKA is sleeping');
    return { skipped: true, reason: 'asleep' };
  }
  logger.info('[FRAKA] Starting hourly review...');

  // Gather ALL context for deep analysis
  const status = getSystemStatus();
  const metrics1h = readMetrics(1);
  const metrics24h = readMetrics(24);
  const reports = readReports(3);
  const budget = budgetCheck();
  const pendingProposals = listProposals({ status: 'pending' });
  const recentFeedback = getRecentFeedback(15);

  const context = {
    liveStatus: status,
    metricsLast1h: metrics1h,
    metricsLast24h: metrics24h,
    recentReports: reports,
    budget,
    pendingProposals: pendingProposals.map(p => ({
      id: p.id, type: p.type, description: p.description, audience: p.audience, createdAt: p.createdAt,
    })),
    techFeedback: recentFeedback,
    reviewTimestamp: new Date().toISOString(),
  };

  const ceoDirectives = require('./ceoDirectives');
  const directivesBlock = ceoDirectives.buildDirectivesBlock();

  const userPrompt = [
    directivesBlock,
    directivesBlock ? '' : null,
    '=== HOURLY REVIEW INPUT ===',
    JSON.stringify(context, null, 2),
    '',
    'Produce your structured review as JSON per the rules. Focus on:',
    '- PROCESS HEALTH: Is every engine (Search Pulse, Journey, Zipy, Full Booking) producing fresh data? If any engine has 0 runs in the last hour, flag it.',
    '- TAB DATA: Would every dashboard tab (Live, Performance, History, Zipy, Cost) show fresh data right now? If any tab would be empty or stale, flag it and propose a fix.',
    '- DIRECTIVE COMPLIANCE: Are you fully obeying every CEO directive above? If not, flag the violation in criticalAlerts.',
    '- What changed in the last hour?',
    '- Are there any CRITICAL health issues that need real-time alerts?',
    '- Is budget on track? (< 80% = ok, 80-100% = warn, >= 100% = cap-reached)',
    '- What concrete changes should CEO or Tech approve to improve things?',
  ].filter(l => l !== null).join('\n');

  const review = await callClaude({
    system: FRAKA_REVIEW_PROMPT,
    userText: userPrompt,
    model: settings.FRAKA_ANALYSIS_MODEL,
    maxTokens: 2048,
    label: 'fraka/hourly-review',
  });

  if (!review) {
    logger.error('[FRAKA] Hourly review failed — no response from Claude');
    return null;
  }

  logger.info(`[FRAKA] Review complete — ${review.issuesFound?.length || 0} issues, ${review.proposedChanges?.length || 0} proposed changes`);

  // Persist proposals
  const createdProposals = [];
  for (const pc of (review.proposedChanges || [])) {
    try {
      const saved = proposalsStore.createProposal(pc, 'fraka-review');
      createdProposals.push(saved);
    } catch (err) {
      logger.error(`[FRAKA] Failed to save review proposal: ${err.message}`);
    }
  }

  // Reviews are stored in frakaState but NOT posted to chats unless explicitly
  // requested by the CEO. This prevents review spam in the conversation.
  // The CEO can ask "give me a review" in chat and FRAKA will respond with the
  // latest review data from frakaState. Critical alerts still surface via the
  // red banner on the dashboard (pollFrakaStatus checks criticalAlerts).
  logger.info(`[FRAKA] Review complete — stored silently (not posted to chats per CEO directive)`);

  // Persist FRAKA state
  const prevState = readFrakaState();
  const newState = {
    ...prevState,
    lastReviewAt: new Date().toISOString(),
    lastReviewSummary: review.summary || '',
    lastHeadlineMetrics: review.headlineMetrics || null,
    criticalAlerts: review.criticalAlerts || [],
    totalReviews: (prevState.totalReviews || 0) + 1,
  };
  writeFrakaState(newState);

  return review;
}

function buildCeoMessage(review, proposals) {
  const ceoProposals = proposals.filter(p => p.audience === 'ceo' || p.audience === 'both');
  const lines = [
    `**Hourly Review — ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}**`,
    '',
    review.summary || 'No summary available.',
    '',
  ];

  if (review.headlineMetrics) {
    const h = review.headlineMetrics;
    lines.push(`**Snapshot:** Health ${h.engineHealth || '—'} · ${h.runsLastHour || 0} runs · ${h.bugsFoundLastHour || 0} bugs · $${(h.costLast24hUsd || 0).toFixed(3)} (${h.budgetUsedPct || 0}% of budget)`);
    lines.push('');
  }

  if (review.ceoNote) {
    lines.push(`**Note for you:** ${review.ceoNote}`);
    lines.push('');
  }

  if (review.criticalAlerts && review.criticalAlerts.length) {
    lines.push('**🚨 Critical alerts:**');
    review.criticalAlerts.forEach(a => lines.push(`- ${a}`));
    lines.push('');
  }

  if (ceoProposals.length) {
    lines.push(`**${ceoProposals.length} proposal${ceoProposals.length > 1 ? 's' : ''} awaiting your approval:**`);
    ceoProposals.forEach(p => lines.push(`- [${p.type}] ${p.description}`));
  }

  return lines.join('\n');
}

function buildTechMessage(review, proposals) {
  const techProposals = proposals.filter(p => p.audience === 'tech' || p.audience === 'both');
  const lines = [
    `**Hourly Review — ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}**`,
    '',
    review.summary || 'No summary available.',
    '',
  ];

  if (review.techNote) {
    lines.push(`**Note for the team:** ${review.techNote}`);
    lines.push('');
  }

  if (review.issuesFound && review.issuesFound.length) {
    lines.push(`**${review.issuesFound.length} issue${review.issuesFound.length > 1 ? 's' : ''} detected:**`);
    review.issuesFound.forEach(i => lines.push(`- [${i.severity}] ${i.title} — ${i.evidence}`));
    lines.push('');
  }

  if (techProposals.length) {
    lines.push(`**${techProposals.length} proposal${techProposals.length > 1 ? 's' : ''} awaiting your approval:**`);
    techProposals.forEach(p => lines.push(`- [${p.type}] ${p.description}`));
  }

  return lines.join('\n');
}

module.exports = { runHourlyReview, readFrakaState, writeFrakaState, isFrakaAwake };
