const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const trendCache = require('../engine1-zipy/trendCache');
const scenarioPicker = require('./scenarioPicker');
const browserModule = require('./browser');
const login = require('./login');
const journeyReportBuilder = require('../reporter/journeyReportBuilder');

// Flight steps
const flightSearch = require('./flight/flightSearch');
const flightResults = require('./flight/flightResults');
const flightAddons = require('./flight/flightAddons');
const passengerForm = require('./flight/passengerForm');
const reviewPage = require('./flight/reviewPage');
const paymentPage = require('./flight/paymentPage');

// Hotel steps
const hotelSearch = require('./hotel/hotelSearch');
const hotelResults = require('./hotel/hotelResults');
const hotelRoomSelect = require('./hotel/hotelRoomSelect');
const guestForm = require('./hotel/guestForm');
const hotelPayment = require('./hotel/hotelPayment');

const RUN_HISTORY_PATH = path.join(__dirname, '..', 'state', 'runHistory.json');

function generateRunId(prefix) {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}-${ts}`;
}

async function runFlightJourney(page, scenario, runId) {
  const steps = [];
  logger.info(`[JOURNEY] === FLIGHT JOURNEY START: ${scenario.label} ===`);

  // Step 1: Search
  const searchResult = await flightSearch.execute(page, scenario, runId);
  steps.push(searchResult);
  if (searchResult.status === 'failed') {
    logger.warn('[JOURNEY] Flight search failed — skipping remaining flight steps');
    return steps;
  }

  // Step 2: Results + Filters + Selection
  const resultsResult = await flightResults.execute(page, scenario, runId);
  steps.push(resultsResult);
  if (resultsResult.status === 'failed') {
    logger.warn('[JOURNEY] Flight results failed — skipping remaining flight steps');
    return steps;
  }

  // Step 3: Add-ons (optional)
  const addonsResult = await flightAddons.execute(page, scenario, runId);
  steps.push(addonsResult);

  // Step 4: Passenger form
  const paxResult = await passengerForm.execute(page, scenario, runId);
  steps.push(paxResult);
  if (paxResult.status === 'failed') {
    logger.warn('[JOURNEY] Passenger form failed — skipping remaining flight steps');
    return steps;
  }

  // Step 5: Review page
  const reviewResult = await reviewPage.execute(page, scenario, runId);
  steps.push(reviewResult);
  if (reviewResult.status === 'failed') {
    logger.warn('[JOURNEY] Review page failed — skipping payment page');
    return steps;
  }

  // Step 6: Payment page (STOP here)
  const paymentResult = await paymentPage.execute(page, scenario, runId);
  steps.push(paymentResult);

  logger.info(`[JOURNEY] === FLIGHT JOURNEY END ===`);
  return steps;
}

async function runHotelJourney(page, scenario, runId) {
  const steps = [];
  logger.info(`[JOURNEY] === HOTEL JOURNEY START: ${scenario.label} ===`);

  // Step 1: Search
  const searchResult = await hotelSearch.execute(page, scenario, runId);
  steps.push(searchResult);
  if (searchResult.status === 'failed') {
    logger.warn('[JOURNEY] Hotel search failed — skipping remaining hotel steps');
    return steps;
  }

  // Step 2: Results + Filters
  const resultsResult = await hotelResults.execute(page, scenario, runId);
  steps.push(resultsResult);
  if (resultsResult.status === 'failed') {
    logger.warn('[JOURNEY] Hotel results failed — skipping remaining hotel steps');
    return steps;
  }

  // Step 3: Room selection
  const roomResult = await hotelRoomSelect.execute(page, scenario, runId);
  steps.push(roomResult);
  if (roomResult.status === 'failed') {
    logger.warn('[JOURNEY] Room selection failed — skipping remaining hotel steps');
    return steps;
  }

  // Step 4: Guest form
  const guestResult = await guestForm.execute(page, scenario, runId);
  steps.push(guestResult);
  if (guestResult.status === 'failed') {
    logger.warn('[JOURNEY] Guest form failed — skipping payment page');
    return steps;
  }

  // Step 5: Payment page (STOP here)
  const paymentResult = await hotelPayment.execute(page, scenario, runId);
  steps.push(paymentResult);

  logger.info(`[JOURNEY] === HOTEL JOURNEY END ===`);
  return steps;
}

function updateRunHistory(runId, reportPath, flightScenarioId, hotelScenarioId) {
  let history = [];
  try {
    if (fs.existsSync(RUN_HISTORY_PATH)) {
      history = JSON.parse(fs.readFileSync(RUN_HISTORY_PATH, 'utf-8'));
    }
  } catch { /* start fresh */ }

  history.push({
    runId,
    timestamp: new Date().toISOString(),
    reportPath,
    flightScenarioId,
    hotelScenarioId,
  });

  // Keep only last 20 runs
  if (history.length > 20) {
    history = history.slice(-20);
  }

  fs.writeFileSync(RUN_HISTORY_PATH, JSON.stringify(history, null, 2));
}

async function runJourneyEngine() {
  const { resetSessionTokens, getSessionTokens, getSessionEvalModes } = require('../utils/tokenOptimizer');
  const { writeMetrics } = require('../utils/metricsWriter');
  resetSessionTokens();

  const runId = generateRunId('JOURNEY');
  const startTime = new Date();
  const runData = { runId, startTime, steps: [] };

  logger.info(`[JOURNEY] Engine starting — Run ${runId}`);

  let browser = null;

  try {
    // Step 1: Load today's Zipy trends if available
    const trendData = trendCache.read();
    if (trendData) {
      logger.info('[JOURNEY] Zipy trend data available for today');
      runData.trendData = trendData;
    } else {
      logger.info('[JOURNEY] No Zipy trend data for today — using prebuilt scenarios only');
    }

    // Step 2: Pick scenarios
    const { flightScenario, hotelScenario } = await scenarioPicker.pick(trendData);
    runData.flightScenario = flightScenario;
    runData.hotelScenario = hotelScenario;

    // Step 3: Launch browser + login
    const browserResult = await browserModule.launch();
    browser = browserResult.browser;
    const page = browserResult.page;

    await login.authenticate(page);

    // Step 4: Run flight journey
    runData.flightSteps = await runFlightJourney(page, flightScenario, runId);

    // Step 5: Run hotel journey (same browser session)
    runData.hotelSteps = await runHotelJourney(page, hotelScenario, runId);

    // Step 6: Build journey report
    runData.endTime = new Date();
    runData.durationMs = runData.endTime - startTime;
    const reportPath = await journeyReportBuilder.build(runData, trendData);

    // Step 7: Update run history
    updateRunHistory(runId, reportPath, flightScenario.id, hotelScenario.id);

    // Step 8: Write metrics for dashboard
    const tokens = getSessionTokens();
    const evalModes = getSessionEvalModes();
    const allSteps = [...(runData.flightSteps || []), ...(runData.hotelSteps || [])];
    let bugsP0 = 0, bugsP1 = 0, bugsP2 = 0, bugsP3 = 0, uxIssues = 0;
    let passed = 0, warned = 0, failed = 0;
    for (const step of allSteps) {
      const ev = step.evaluation || {};
      for (const bug of ev.bugs || []) {
        if (bug.severity === 'P0') bugsP0++;
        else if (bug.severity === 'P1') bugsP1++;
        else if (bug.severity === 'P2') bugsP2++;
        else if (bug.severity === 'P3') bugsP3++;
      }
      uxIssues += (ev.uxFriction || []).length;
      const s = (ev.overallStatus || '').toUpperCase();
      if (s === 'PASS') passed++;
      else if (s === 'WARN') warned++;
      else if (s === 'FAIL') failed++;
    }
    const overallStatus = failed > 0 ? 'FAIL' : warned > 0 ? 'WARN' : 'PASS';

    await writeMetrics({
      engineType: 'journey',
      overallStatus,
      flightScenarioId: flightScenario.id,
      hotelScenarioId: hotelScenario.id,
      flightType: flightScenario.type,
      tripType: flightScenario.tripType,
      scenarioSource: flightScenario.source || 'prebuilt',
      route: flightScenario.from && flightScenario.to ? `${flightScenario.from}→${flightScenario.to}` : null,
      bugsP0, bugsP1, bugsP2, bugsP3,
      uxIssues,
      passed, warned, failed,
      durationMs: runData.durationMs,
      tokensInput: tokens.input,
      tokensOutput: tokens.output,
      tokensUsed: tokens.total,
      apiCalls: tokens.calls,
      evalsFast: evalModes.fast,
      evalsStandard: evalModes.standard,
      evalsDeep: evalModes.deep,
      reportPath,
    });

    logger.info(`[JOURNEY] Complete — Report: ${reportPath}`);
    return { success: true, reportPath };
  } catch (err) {
    logger.error(`[JOURNEY] Engine failed: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

module.exports = { runJourneyEngine };
