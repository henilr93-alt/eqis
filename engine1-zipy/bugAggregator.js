const { callClaude } = require('../utils/tokenOptimizer');
const logger = require('../utils/logger');

async function aggregate(allSessions, sessionAnalyses) {
  const allBugs = [];
  for (const analysis of sessionAnalyses) {
    for (const bug of analysis.bugsObserved || []) {
      allBugs.push({ ...bug, fromSession: analysis.sessionId });
    }
  }

  logger.info(`[AGGREGATOR] Aggregating ${allBugs.length} raw bugs from ${sessionAnalyses.length} sessions`);

  if (allBugs.length === 0) {
    return {
      totalBugsRaw: 0, uniqueBugsFound: 0,
      systemicBugs: [], otherBugs: [],
      criticalSummary: 'No bugs were observed in the analyzed sessions.',
    };
  }

  const AGGREGATION_PROMPT = `Deduplicate and rank these bugs from ${sessionAnalyses.length} real user sessions.
1. DEDUPLICATE same issues described differently
2. COUNT sessions per bug
3. RANK by (occurrences x severity: P0=4, P1=3, P2=2, P3=1)
4. Flag 3+ session bugs as SYSTEMIC

Return JSON:
{
  "totalBugsRaw": number, "uniqueBugsFound": number,
  "systemicBugs": [{"bugId": string, "severity": string, "occurrences": number, "sessionCount": number, "title": string, "consolidatedDescription": string, "affectedPage": string, "devFixRequired": string, "urgencyScore": number, "isSystemic": true, "exampleSessions": [string]}],
  "otherBugs": [same shape, isSystemic: false],
  "criticalSummary": string
}`;

  const result = await callClaude({
    system: AGGREGATION_PROMPT,
    userText: JSON.stringify(allBugs, null, 2),
    mode: 'DEEP',
    label: 'zipy/bugAggregation',
  });

  if (result) {
    logger.info(`[AGGREGATOR] ${result.uniqueBugsFound} unique bugs, ${result.systemicBugs?.length || 0} systemic`);
    return result;
  }

  // Fallback
  return {
    totalBugsRaw: allBugs.length, uniqueBugsFound: allBugs.length,
    systemicBugs: [],
    otherBugs: allBugs.map((b, i) => ({
      bugId: `BUG-${String(i + 1).padStart(3, '0')}`, severity: b.severity,
      occurrences: 1, sessionCount: 1, title: b.title,
      consolidatedDescription: b.description, affectedPage: b.pageWhere,
      devFixRequired: b.devFixRequired, urgencyScore: 1,
      isSystemic: false, exampleSessions: [b.fromSession],
    })),
    criticalSummary: 'Bug aggregation failed — showing raw bugs.',
  };
}

module.exports = { aggregate };
