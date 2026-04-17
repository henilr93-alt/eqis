const logger = require('../utils/logger');
const zipyLogin = require('./zipyLogin');
const sessionHarvester = require('./sessionHarvester');
const sessionSelector = require('./sessionSelector');
const sessionAnalyzer = require('./sessionAnalyzer');
const bugAggregator = require('./bugAggregator');
const trendExtractor = require('./trendExtractor');
const trendCache = require('./trendCache');
const sessionMirror = require('./sessionMirror');
const zipyReportBuilder = require('../reporter/zipyReportBuilder');

function generateRunId(prefix) {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}-${ts}`;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Generate diagnostic report when harvester fails or returns empty
async function generateDiagnosticReport(page, runId, harvestError = null, sessionCount = 0) {
  const diagnostic = {
    runId,
    timestamp: new Date().toISOString(),
    sessionCount,
    harvestError: harvestError ? harvestError.message : null,
    loginStatus: 'unknown',
    authUrlReached: false,
    currentUrl: '',
    currentTitle: '',
    domStats: {
      tablesFound: 0,
      rowsFound: 0,
      clickableDivs: 0,
      sessionElements: 0
    }
  };

  try {
    // Capture current page state
    diagnostic.currentUrl = page.url();
    diagnostic.currentTitle = await page.title().catch(() => 'N/A');
    
    // Check login status by looking for auth indicators
    const authIndicators = await page.evaluate(() => {
      const hasLogoutButton = !!document.querySelector('button[onclick*="logout"], a[href*="logout"], .logout');
      const hasUserProfile = !!document.querySelector('.user-profile, .profile, [class*="user"][class*="name"]');
      const hasLoginForm = !!document.querySelector('form[action*="login"], input[type="password"], .login-form');
      const urlContainsAuth = window.location.href.includes('/auth') || window.location.href.includes('/login');
      
      return { hasLogoutButton, hasUserProfile, hasLoginForm, urlContainsAuth };
    }).catch(() => ({ hasLogoutButton: false, hasUserProfile: false, hasLoginForm: false, urlContainsAuth: false }));
    
    diagnostic.loginStatus = authIndicators.hasLogoutButton || authIndicators.hasUserProfile ? 'logged_in' : 'logged_out';
    diagnostic.authUrlReached = authIndicators.urlContainsAuth;
    
    // Explore DOM for session-related elements
    const domStats = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      let rowsFound = 0;
      tables.forEach(table => {
        rowsFound += table.querySelectorAll('tr').length;
      });
      
      const clickableDivs = document.querySelectorAll('div[onclick], div[role="button"], .clickable, .btn').length;
      
      // Look for session-specific elements
      const sessionKeywords = ['session', 'replay', 'recording', 'timeline', 'event'];
      let sessionElements = 0;
      sessionKeywords.forEach(keyword => {
        sessionElements += document.querySelectorAll(`[class*="${keyword}"], [id*="${keyword}"]`).length;
      });
      
      return {
        tablesFound: tables.length,
        rowsFound,
        clickableDivs,
        sessionElements
      };
    }).catch(() => ({ tablesFound: 0, rowsFound: 0, clickableDivs: 0, sessionElements: 0 }));
    
    diagnostic.domStats = domStats;
    
  } catch (err) {
    logger.warn(`[ZIPY] Failed to generate diagnostic info: ${err.message}`);
  }
  
  return diagnostic;
}

async function runZipyEngine() {
  const { resetSessionTokens, getSessionTokens } = require('../utils/tokenOptimizer');
  const { writeMetrics } = require('../utils/metricsWriter');
  resetSessionTokens();

  const runId = generateRunId('ZIPY');
  logger.info(`[ZIPY] Engine starting — Run ${runId}`);

  let browser = null;

  try {
    // Step 1: Login to Zipy
    const loginResult = await zipyLogin.connect();
    browser = loginResult.browser;
    const page = loginResult.page;

    // Step 2: Harvest session metadata (last 24 hours)
    let allSessions = [];
    let harvestError = null;
    let diagnosticReport = null;
    
    try {
      allSessions = await sessionHarvester.harvest(page);
      logger.info(`[ZIPY] Harvested ${allSessions.length} sessions`);
    } catch (err) {
      harvestError = err;
      logger.error(`[ZIPY] Session harvester failed: ${err.message}`);
    }

    // Generate diagnostic report if harvest failed or returned 0 sessions
    if (harvestError || allSessions.length === 0) {
      logger.warn('[ZIPY] Generating diagnostic report due to harvest failure or empty results');
      diagnosticReport = await generateDiagnosticReport(page, runId, harvestError, allSessions.length);
      
      // Pass diagnostic to report builder as engineOutput (the format it expects)
      const reportPath = await zipyReportBuilder.build({
        runId,
        allSessions: [],
        selectedSessions: [],
        sessionAnalyses: [],
        bugReport: { uniqueBugsFound: 0, systemicBugs: [] },
        trends: null,
        engineOutput: {
          loginStatus: {
            success: diagnosticReport.loginStatus === 'logged_in',
            timestamp: diagnosticReport.timestamp,
            url: diagnosticReport.currentUrl,
            error: harvestError ? harvestError.message : null,
          },
          harvesterDiagnostics: {
            domStats: diagnosticReport.domStats,
            currentUrl: diagnosticReport.currentUrl,
            pageTitle: diagnosticReport.pageTitle,
            sessionsFound: 0,
          },
          errors: harvestError ? [harvestError.message] : [],
          lastKnownSessions: [],
        },
      });
      
      await browser.close();
      
      // Write metrics with diagnostic info
      const tokens = getSessionTokens();
      await writeMetrics({
        engineType: 'zipy',
        sessionsHarvested: 0,
        sessionsAnalyzed: 0,
        uniqueBugsFound: 0,
        systemicBugs: 0,
        completionRate: 0,
        errorRate: 0,
        topBugs: [],
        topRoutes: [],
        topHotels: [],
        mirrorScenariosGenerated: 0,
        tokensInput: tokens.input,
        tokensOutput: tokens.output,
        tokensUsed: tokens.total,
        apiCalls: tokens.calls,
        reportPath,
        diagnosticStatus: 'harvest_failed',
        diagnosticData: diagnosticReport
      });
      
      logger.info(`[ZIPY] Diagnostic report generated — Report: ${reportPath}`);
      return { success: true, reportPath, diagnostic: true };
    }

    // Step 3: AI selects best sessions to deep-analyze (randomly sample 5 per CEO directive)
    const selectedSessions = await sessionSelector.pick(allSessions, { maxSessions: 5, randomSample: true });
    logger.info(`[ZIPY] Selected ${selectedSessions.length} sessions for deep analysis`);

    // Step 4: Deep analyze each selected session
    const sessionAnalyses = [];
    for (const session of selectedSessions) {
      const analysis = await sessionAnalyzer.analyze(page, session);
      sessionAnalyses.push(analysis);
      await delay(3000); // avoid bot detection
    }

    // Step 5: Aggregate repeated bugs across all sessions
    const bugReport = await bugAggregator.aggregate(allSessions, sessionAnalyses);
    logger.info(`[ZIPY] Bug report: ${bugReport.uniqueBugsFound} unique, ${bugReport.systemicBugs?.length || 0} systemic`);

    // Step 5.5: Build mirror scenarios from analyzed sessions
    const mirrorScenarios = await sessionMirror.run(sessionAnalyses);
    logger.info(`[ZIPY] Mirror scenarios: ${mirrorScenarios.length} generated`);

    // Step 6: Extract search trends
    const trends = await trendExtractor.extract(allSessions, sessionAnalyses);

    // Step 7: Write trends + mirrors to shared cache for Engine 2 and 3
    const dynamicScenarios = convertToDynamicScenarios(trends);
    await trendCache.write({
      trends,
      dynamicScenarios,
      mirrorScenarios,
    });

    // Step 8: Build Zipy HTML report
    const reportPath = await zipyReportBuilder.build({
      runId,
      allSessions,
      selectedSessions,
      sessionAnalyses,
      bugReport,
      trends,
    });

    await browser.close();
    browser = null;

    // Write metrics for dashboard
    const tokens = getSessionTokens();
    const completedSessions = sessionAnalyses.filter(a => a.completedToPayment).length;
    const completionRate = sessionAnalyses.length > 0 ? Math.round((completedSessions / sessionAnalyses.length) * 100) : 0;
    const topBugs = (bugReport.systemicBugs || []).slice(0, 5).map(b => ({
      title: b.title, severity: b.severity, occurrences: b.occurrences,
    }));
    const topRoutes = (trends?.flightTrends?.topRoutes || []).slice(0, 5);
    const topHotels = (trends?.hotelTrends?.topDestinations || []).slice(0, 5);

    await writeMetrics({
      engineType: 'zipy',
      sessionsHarvested: allSessions.length,
      sessionsAnalyzed: sessionAnalyses.length,
      uniqueBugsFound: bugReport.uniqueBugsFound || 0,
      systemicBugs: (bugReport.systemicBugs || []).length,
      completionRate,
      errorRate: parseInt(trends?.behavioralPatterns?.errorRate) || 0,
      topBugs,
      topRoutes,
      topHotels,
      mirrorScenariosGenerated: mirrorScenarios.length,
      tokensInput: tokens.input,
      tokensOutput: tokens.output,
      tokensUsed: tokens.total,
      apiCalls: tokens.calls,
      reportPath,
    });

    logger.info(`[ZIPY] Complete — Report: ${reportPath}`);
    return { success: true, reportPath };
  } catch (err) {
    logger.error(`[ZIPY] Engine failed: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

function convertToDynamicScenarios(trends) {
  const scenarios = [];
  const recommended = trends.recommendedTestScenarios || [];
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  for (let i = 0; i < Math.min(recommended.length, 3); i++) {
    const rec = recommended[i];
    const id = `DYN-${today}-${String(i + 1).padStart(3, '0')}`;

    const isHotel = rec.fromType?.includes('hotel');

    if (isHotel) {
      scenarios.push({
        id,
        label: `TREND-DRIVEN: ${rec.scenarioDescription}`,
        source: 'zipy_trend',
        trendReason: rec.reason,
        generatedAt: new Date().toISOString(),
        urgency: rec.urgency,
        type: rec.fromType?.includes('international') ? 'international' : 'domestic',
        destination: rec.destination || 'Mumbai',
        destinationCode: '',
        checkinOffsetDays: 7,
        nights: 3,
        rooms: 1,
        adultsPerRoom: 2,
        childrenPerRoom: 0,
        starFilter: '4',
        filtersToApply: ['sort_by_price'],
        preferRoomType: 'Deluxe Room',
      });
    } else {
      scenarios.push({
        id,
        label: `TREND-DRIVEN: ${rec.scenarioDescription}`,
        source: 'zipy_trend',
        trendReason: rec.reason,
        generatedAt: new Date().toISOString(),
        urgency: rec.urgency,
        type: rec.fromType?.includes('international') ? 'international' : 'domestic',
        tripType: 'one-way',
        from: rec.origin || 'BOM',
        fromCity: rec.origin || 'Mumbai',
        to: rec.destination || 'DEL',
        toCity: rec.destination || 'Delhi',
        cabinClass: rec.classSuggestion || 'Economy',
        passengers: { adults: 1, children: 0, infants: 0 },
        dateOffsetDays: 7,
        filtersToApply: ['sort_by_price'],
        preferNonStop: false,
      });
    }
  }

  return scenarios;
}

module.exports = { runZipyEngine };