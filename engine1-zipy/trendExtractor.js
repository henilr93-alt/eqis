const { callClaude } = require('../utils/tokenOptimizer');
const logger = require('../utils/logger');

const TREND_PROMPT = `Extract search trends and behavioral patterns from this B2B travel platform data (new.etrav.in, Indian travel agents).

Return ONLY JSON:
{
  "date": string, "totalSessions": number, "analysisWindow": "last_24_hours",
  "flightTrends": {
    "topRoutes": [{"route": string, "count": number, "pct": string}],
    "domesticVsInternational": {"domestic": number, "international": number},
    "topDepartureCities": [{"city": string, "count": number}],
    "topArrivalCities": [{"city": string, "count": number}],
    "classDistribution": {"economy": number, "business": number},
    "peakSearchHours": [{"hour": string, "count": number}],
    "avgPassengerCount": number
  },
  "hotelTrends": {
    "topDestinations": [{"destination": string, "count": number}],
    "domesticVsInternational": {"domestic": number, "international": number},
    "avgStayDuration": number,
    "popularStarRatings": [{"stars": string, "count": number}],
    "avgRoomCount": number
  },
  "behavioralPatterns": {
    "avgSessionDuration": number, "completionRate": string,
    "topDropOffPages": [{"page": string, "pct": string}],
    "errorRate": string, "mobileVsDesktop": {"mobile": number, "desktop": number},
    "avgPagesPerSession": number
  },
  "anomalies": [{"flag": string, "severity": "HIGH"|"MEDIUM"|"LOW", "detail": string, "affectsRoute": string|null}],
  "recommendedTestScenarios": [{"scenarioDescription": string, "reason": string, "fromType": string, "origin": string|null, "destination": string|null, "urgency": "URGENT"|"HIGH"|"MEDIUM", "passengerSuggestion": string, "classSuggestion": "Economy"|"Business"}],
  "narrativeSummary": string
}`;

async function extract(allSessions, sessionAnalyses) {
  logger.info(`[TRENDS] Extracting from ${allSessions.length} sessions and ${sessionAnalyses.length} analyses`);

  const data = {
    sessions: allSessions.map(s => ({
      sessionId: s.sessionId, duration: s.duration, pageCount: s.pageCount,
      errorCount: s.errorCount, hasRageClicks: s.hasRageClicks,
      lastPage: s.lastPage, deviceType: s.deviceType, startTime: s.startTime,
    })),
    analyses: sessionAnalyses.map(a => ({
      sessionId: a.sessionId, productUsed: a.productUsed,
      journeyStage: a.journeyStage, completedToPayment: a.completedToPayment,
      dropOffStep: a.dropOffStep, searchPattern: a.searchPattern,
      bugCount: (a.bugsObserved || []).length, frictionCount: (a.frictionPoints || []).length,
    })),
  };

  const trends = await callClaude({
    system: TREND_PROMPT,
    userText: JSON.stringify(data, null, 2),
    mode: 'DEEP',
    label: 'zipy/trendExtraction',
  });

  if (trends) {
    logger.info(`[TRENDS] ${trends.recommendedTestScenarios?.length || 0} recommended scenarios`);
    return trends;
  }

  // Fallback
  return {
    date: new Date().toISOString().slice(0, 10),
    totalSessions: allSessions.length, analysisWindow: 'last_24_hours',
    flightTrends: { topRoutes: [], domesticVsInternational: {}, topDepartureCities: [], topArrivalCities: [], classDistribution: {}, peakSearchHours: [], avgPassengerCount: 0 },
    hotelTrends: { topDestinations: [], domesticVsInternational: {}, avgStayDuration: 0, popularStarRatings: [], avgRoomCount: 0 },
    behavioralPatterns: { avgSessionDuration: 0, completionRate: '0%', topDropOffPages: [], errorRate: '0%', mobileVsDesktop: {}, avgPagesPerSession: 0 },
    anomalies: [], recommendedTestScenarios: [],
    narrativeSummary: 'Trend extraction failed.',
  };
}

module.exports = { extract };
