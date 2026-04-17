// Pain-point analyzer — produces TWO perspectives for the CEO dashboard:
//
//   1. CRITICAL BUGS — issues requiring immediate fix, funneled by severity
//      with persistence tracking (how long each has been on the system).
//
//   2. DEVELOPMENTS — user-journey enhancement suggestions derived from
//      Zipy sessions + metric patterns, tracked with tech team approval
//      status and due dates.

const fs = require('fs');
const path = require('path');
const settings = require('../../config/settings');
const logger = require('../../utils/logger');
const { callClaude } = require('../../utils/tokenOptimizer');
const { FRAKA_IDENTITY, FRAKA_RULES } = require('../systemPrompt');
const issueTracker = require('./issueTracker');
const developmentsStore = require('../developmentsStore');
const { readMetrics } = require('./readMetrics');
const { readReports } = require('./readReports');
const { getSystemStatus } = require('./systemStatus');
const { budgetCheck } = require('./budgetCheck');
const { getRecentFeedback } = require('./techFeedback');

const PAIN_POINTS_PATH = path.join(__dirname, '..', '..', 'state', 'fraka', 'painPoints.json');
const METRICS_PATH = path.join(__dirname, '..', '..', 'state', 'metricsHistory.json');

function loadRawMetrics() {
  try { return JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8')); } catch { return []; }
}

function loadStore() {
  try { return JSON.parse(fs.readFileSync(PAIN_POINTS_PATH, 'utf-8')); }
  catch { return { painPoints: [], issueFingerprints: {}, lastUpdatedAt: null }; }
}

function saveStore(store) {
  fs.writeFileSync(PAIN_POINTS_PATH, JSON.stringify(store, null, 2));
}

const ANALYSIS_SYSTEM_PROMPT = `${FRAKA_IDENTITY}

${FRAKA_RULES}

You are in CEO-DASHBOARD ANALYSIS mode. The CEO needs a board-ready view of
TWO perspectives on new.etrav.in:

═══════════════════════════════════════════════════════════════
PERSPECTIVE 1 — CRITICAL BUGS (immediate action needed)
═══════════════════════════════════════════════════════════════
Bugs that block agents or actively hurt bookings right now.
Extract from: Journey test bug counts (bugsP0-P3), Search Pulse zero-result
routes, load-time spikes, API errors, filter failures.

Each bug has:
  - category   (high-level: "Flight Search", "Hotel Search", "Payment Flow",
                "API Health", "Booking Flow", "Search Performance", "Data Quality",
                "UX Friction")
  - subcategory (specific: "Zero Results", "Slow Load Time", "Filter Broken",
                 "Fare Change Mid-Flow", "Session Timeout", etc.)
  - severity    (P0=blocks booking | P1=major friction | P2=minor friction | P3=cosmetic)
  - title       (one-line statement of the bug)
  - customerImpact (agent-perspective sentence)
  - evidence    (cite metrics/routes/timestamps)
  - affectedScope (routes, engines, scenarios)
  - suggestedAction (concrete next step for tech team)
  - occurrenceCount (how many times you saw it in the data)
  - remarks     (optional extra context)

Order bugs: HIGHEST severity first, then HIGHEST occurrence count.

═══════════════════════════════════════════════════════════════
PERSPECTIVE 2 — DEVELOPMENTS (journey improvements)
═══════════════════════════════════════════════════════════════
Enhancements that would make the agent's booking journey easier day by day.
These are NOT bugs — they are product improvements derived from observed
friction patterns in metrics, Zipy sessions (if present), and tech feedback.

Each development has:
  - category    ("User Journey", "Search Experience", "Booking Flow",
                 "Performance", "Data Coverage", "Agent Tools")
  - subcategory (specific: "Autosuggest", "Pre-fill Defaults", "Bulk Booking",
                 "Mobile Optimization", "Fare Comparison", etc.)
  - title       (one-line improvement idea)
  - description (2-3 sentence explanation)
  - customerBenefit (how it makes the agent's job easier — be concrete)
  - evidence    (what pattern or feedback inspired this)
  - priority    (HIGH | MEDIUM | LOW — business impact)
  - effort      (S | M | L | XL — engineering effort)

Only propose developments that are reasonable given the observed data.
Do NOT invent features that aren't grounded in evidence.

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT — return JSON only, no prose outside:
═══════════════════════════════════════════════════════════════
{
  "summary": "2-3 sentence executive summary (for CEO)",
  "engineHealthNarrative": "1-2 sentences on overall engine health",
  "topRecommendation": "One-sentence highest-priority action",
  "criticalBugs": [
    {
      "category": "...",
      "subcategory": "...",
      "severity": "P0|P1|P2|P3",
      "title": "...",
      "customerImpact": "...",
      "evidence": "...",
      "affectedScope": "...",
      "suggestedAction": "...",
      "occurrenceCount": 0,
      "remarks": "..."
    }
  ],
  "developments": [
    {
      "category": "...",
      "subcategory": "...",
      "title": "...",
      "description": "...",
      "customerBenefit": "...",
      "evidence": "...",
      "priority": "HIGH|MEDIUM|LOW",
      "effort": "S|M|L|XL"
    }
  ],
  "bugCategoryBreakdown": { "Flight Search": 3, "Hotel Search": 2 },
  "developmentCategoryBreakdown": { "User Journey": 4, "Search Experience": 2 }
}

Grounding rule: If the data is sparse, return fewer items. Never fabricate.
If no Zipy sessions exist yet, DERIVE developments from observed friction
patterns in metricsHistory (load times, zero-result routes, bug patterns).`;

function gatherRawContext(windowHours = 168 /* 7 days */) {
  const history = loadRawMetrics();
  const cutoff = new Date(Date.now() - windowHours * 3600 * 1000);
  const recent = history.filter(e => new Date(e.timestamp) >= cutoff);

  const compact = recent.map(e => {
    const base = { t: e.timestamp, engine: e.engineType };
    if (e.engineType === 'searchpulse') {
      return { ...base,
        health: e.overallHealth,
        avgLoadMs: e.avgLoadTimeMs,
        flightResults: e.flightResultCount,
        hotelResults: e.hotelResultCount,
        filterPassRate: e.filterPassRate,
        apiErrors: e.apiErrors,
        zeroResultRoutes: e.zeroResultRoutes,
      };
    }
    if (e.engineType === 'journey') {
      return { ...base,
        status: e.overallStatus,
        flightScenario: e.flightScenarioId,
        hotelScenario: e.hotelScenarioId,
        route: e.route,
        bugsP0: e.bugsP0, bugsP1: e.bugsP1, bugsP2: e.bugsP2, bugsP3: e.bugsP3,
        uxIssues: e.uxIssues,
        failed: e.failed,
      };
    }
    if (e.engineType === 'zipy') {
      return { ...base,
        sessionsAnalyzed: e.sessionsAnalyzed,
        uniqueBugs: e.uniqueBugsFound,
        systemic: e.systemicBugs,
        completionRate: e.completionRate,
        errorRate: e.errorRate,
        topBugs: (e.topBugs || []).slice(0, 5),
      };
    }
    if (e.engineType === 'fullbooking') {
      return { ...base, pnrsCreated: e.pnrsCreated, cancellationStatus: e.cancellationStatus };
    }
    return base;
  });

  return {
    windowHours,
    totalEntries: compact.length,
    entries: compact,
    aggregatedLast24h: readMetrics(24),
    aggregatedLast7d: readMetrics(168),
    liveStatus: getSystemStatus(),
    recentReports: readReports(5),
    budget: budgetCheck(),
    techFeedback: getRecentFeedback(15),
  };
}

/**
 * Main entry point — runs the full two-perspective analysis.
 */
async function refreshPainPoints(windowHours = 168) {
  logger.info('[FRAKA] Refreshing CEO pain-point + development analysis...');

  const context = gatherRawContext(windowHours);
  if (context.totalEntries === 0) {
    logger.warn('[FRAKA] No metric entries in window — analysis skipped');
    const empty = {
      summary: 'Insufficient data to analyze. Run some engines to begin collecting data.',
      engineHealthNarrative: 'EQIS has not accumulated enough runs in the selected window.',
      topRecommendation: 'Start an engine from the Live tab.',
      criticalBugs: [],
      developments: [],
      bugCategoryBreakdown: {},
      developmentCategoryBreakdown: {},
    };
    persistReport(empty, context);
    return enrichReport(empty);
  }

  const userPrompt = [
    '=== CEO DASHBOARD ANALYSIS INPUT ===',
    '',
    `Analysis window: last ${windowHours} hours (${Math.round(windowHours / 24)} days)`,
    `Total EQIS runs in window: ${context.totalEntries}`,
    '',
    '=== AGGREGATED METRICS (LAST 24H) ===',
    JSON.stringify(context.aggregatedLast24h, null, 2),
    '',
    '=== AGGREGATED METRICS (LAST 7D) ===',
    JSON.stringify(context.aggregatedLast7d, null, 2),
    '',
    '=== LIVE SYSTEM STATUS ===',
    JSON.stringify(context.liveStatus, null, 2),
    '',
    '=== RAW RUNS (compact, last 50) ===',
    JSON.stringify(context.entries.slice(-50), null, 2),
    '',
    '=== RECENT REPORTS ===',
    JSON.stringify(context.recentReports, null, 2),
    '',
    '=== TECH TEAM FEEDBACK NOTES ===',
    JSON.stringify(context.techFeedback, null, 2),
    '',
    '=== BUDGET ===',
    JSON.stringify(context.budget, null, 2),
    '',
    'Now produce the two-perspective JSON per the rules.',
    'Remember: criticalBugs = immediate fixes. developments = journey improvements.',
  ].join('\n');

  const report = await callClaude({
    system: ANALYSIS_SYSTEM_PROMPT,
    userText: userPrompt,
    model: settings.FRAKA_ANALYSIS_MODEL,
    maxTokens: 6000,
    label: 'fraka/ceo-dashboard-analysis',
  });

  if (!report) {
    logger.error('[FRAKA] CEO dashboard analysis failed — no Sonnet response');
    return null;
  }

  // Persist each bug sighting so we can track "days persistent"
  const now = new Date().toISOString();
  const enrichedBugs = (report.criticalBugs || []).map((bug, i) => {
    const rec = issueTracker.recordSighting(bug.category, bug.subcategory, bug.title, now);
    return {
      id: `BUG-${Date.now().toString(36)}-${i}`,
      ...bug,
      firstSeenAt: rec.firstSeen,
      lastSeenAt: rec.lastSeen,
      totalOccurrencesAllTime: rec.occurrences,
      daysPersistent: issueTracker.daysPersistent(rec),
      hoursPersistent: issueTracker.hoursPersistent(rec),
      status: 'ongoing',
    };
  });

  // Sort bugs: severity first, then occurrence count
  const severityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  enrichedBugs.sort((a, b) => {
    const sa = severityRank[a.severity] ?? 9;
    const sb = severityRank[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return (b.occurrenceCount || 0) - (a.occurrenceCount || 0);
  });

  // Upsert developments into the persistent developments store
  // (preserves existing tech-approval state for already-known ideas)
  const upsertedDevelopments = [];
  for (const dev of (report.developments || [])) {
    try {
      const stored = developmentsStore.upsertDevelopment(dev, 'fraka-analysis');
      upsertedDevelopments.push(stored);
    } catch (err) {
      logger.error(`[FRAKA] Failed to upsert development: ${err.message}`);
    }
  }

  // Mark stale bug fingerprints as resolved
  issueTracker.markStaleAsResolved(24);

  const finalReport = {
    summary: report.summary || '',
    engineHealthNarrative: report.engineHealthNarrative || '',
    topRecommendation: report.topRecommendation || '',
    criticalBugs: enrichedBugs,
    bugCategoryBreakdown: report.bugCategoryBreakdown || {},
    developmentCategoryBreakdown: report.developmentCategoryBreakdown || {},
    // developments are not stored here — the authoritative source is developmentsStore,
    // so the CEO dashboard always sees current approval state
  };

  persistReport(finalReport, context);
  logger.info(`[FRAKA] Analysis complete — ${enrichedBugs.length} bugs, ${upsertedDevelopments.length} developments touched`);
  return enrichReport(finalReport);
}

function persistReport(report, context) {
  const prev = loadStore();
  const store = {
    ...prev,
    lastUpdatedAt: new Date().toISOString(),
    coverageWindow: `last ${context?.windowHours || 168} hours`,
    totalRunsAnalyzed: context?.totalEntries || 0,
    summary: report.summary,
    engineHealthNarrative: report.engineHealthNarrative,
    topRecommendation: report.topRecommendation,
    criticalBugs: report.criticalBugs || [],
    bugCategoryBreakdown: report.bugCategoryBreakdown || {},
    developmentCategoryBreakdown: report.developmentCategoryBreakdown || {},
  };
  saveStore(store);
}

/**
 * Assemble the full CEO-dashboard payload:
 * cached bugs + current state of developments store (with approval info).
 */
function enrichReport(bugReport) {
  const store = loadStore();
  const developments = developmentsStore.listDevelopments().map(d => ({
    ...d,
    daysUntilDue: developmentsStore.daysUntilDue(d),
  }));

  return {
    lastUpdatedAt: store.lastUpdatedAt,
    coverageWindow: store.coverageWindow,
    totalRunsAnalyzed: store.totalRunsAnalyzed,
    summary: bugReport?.summary || store.summary || '',
    engineHealthNarrative: bugReport?.engineHealthNarrative || store.engineHealthNarrative || '',
    topRecommendation: bugReport?.topRecommendation || store.topRecommendation || '',
    criticalBugs: bugReport?.criticalBugs || store.criticalBugs || [],
    developments,
    bugCategoryBreakdown: bugReport?.bugCategoryBreakdown || store.bugCategoryBreakdown || {},
    developmentCategoryBreakdown: bugReport?.developmentCategoryBreakdown || store.developmentCategoryBreakdown || {},
    counts: {
      criticalBugs: (bugReport?.criticalBugs || store.criticalBugs || []).length,
      developmentsPending: developments.filter(d => d.techApprovalStatus === 'pending').length,
      developmentsApproved: developments.filter(d => d.techApprovalStatus === 'approved').length,
      developmentsInProgress: developments.filter(d => d.techApprovalStatus === 'in-progress').length,
      developmentsCompleted: developments.filter(d => d.techApprovalStatus === 'completed').length,
      developmentsRejected: developments.filter(d => d.techApprovalStatus === 'rejected').length,
    },
  };
}

function getCachedReport() {
  return enrichReport(null);
}

module.exports = { refreshPainPoints, getCachedReport };
