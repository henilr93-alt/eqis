const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getLocalDateString, getLocalTimeString, getLocalTimestamp } = require('../utils/timezone');
const browserModule = require('../engine2-journey/browser');
const login = require('../engine2-journey/login');
const { pickPulseScenarios } = require('./pulsePicker');
const { runFlightSearchPulse } = require('./flightSearchPulse');
const { runHotelSearchPulse } = require('./hotelSearchPulse');
const trendCache = require('../engine1-zipy/trendCache');
const searchPulseReportBuilder = require('../reporter/searchPulseReportBuilder');
const settings = require('../config/settings');
const { escalateToEtravCMT, MAX_ESCALATIONS_PER_PULSE } = require('./cmtEscalator');
const { shouldRecord, createRecordingPage } = require('../utils/sessionRecorder');

// FIX 5: Pulse lock to prevent concurrent pulse runs. A pulse can take 2-3 minutes.
// The cron fires every 1 min — without this lock, pulses overlap and compete for resources.
let _pulseRunning = false;

function generatePulseId() {
  return `PULSE-${getLocalDateString()}-${getLocalTimeString().replace(':', '')}`;
}

function calculatePulseHealth(pulseData) {
  const allResults = [...pulseData.flightPulses, ...pulseData.hotelPulses];
  const failures = allResults.filter(r => r.searchStatus === 'FAILED').length;
  const zeroResults = allResults.filter(r => r.resultCount === 0 && r.searchStatus !== 'FAILED').length;
  const apiErrors = allResults.filter(r => r.apiErrors > 0).length;
  const delayedResults = allResults.filter(r => r.loadTimeMs > 20000).length;

  // P0: ANY zero-result or failed search = CRITICAL (agents can't book)
  if (failures > 0 || zeroResults > 0) return 'CRITICAL';
  // P1: ANY search taking >20s = DEGRADED (agents waiting too long)
  if (delayedResults > 0 || apiErrors > 1) return 'DEGRADED';
  if (apiErrors === 1) return 'WARN';
  return 'HEALTHY';
}

function extractApiSignals(pulseData) {
  const signals = [];
  const all = [...pulseData.flightPulses, ...pulseData.hotelPulses];
  for (const r of all) {
    if (r.apiErrors > 0) signals.push({ route: r.label, type: 'API_ERROR', errors: r.apiErrors, detail: r.apiErrorDetail });
    if (r.loadTimeMs > 20000) signals.push({ route: r.label, type: 'DELAYED', loadTimeMs: r.loadTimeMs });
    else if (r.loadTimeMs > 8000) signals.push({ route: r.label, type: 'SLOW', loadTimeMs: r.loadTimeMs });
    if (r.resultCount === 0) signals.push({ route: r.label, type: 'ZERO_RESULTS' });
  }
  return signals;
}

function buildCriticalAlerts(pulseData) {
  const alerts = [];
  const all = [...pulseData.flightPulses, ...pulseData.hotelPulses];
  for (const r of all) {
    if (r.resultCount === 0 && r.searchStatus !== 'FAILED') {
      alerts.push({ severity: 'P0', type: 'ZERO_RESULTS', route: r.label, message: 'ZERO RESULTS: ' + r.label + ' returned 0 results', loadTimeMs: r.loadTimeMs });
    }
    if (r.searchStatus === 'FAILED') {
      alerts.push({ severity: 'P0', type: 'SEARCH_FAILED', route: r.label, message: 'SEARCH FAILED: ' + r.label });
    }
    if (r.loadTimeMs > 20000) {
      alerts.push({ severity: 'P1', type: 'DELAYED_RESULTS', route: r.label, message: 'DELAYED: ' + r.label + ' took ' + (r.loadTimeMs / 1000).toFixed(1) + 's (threshold: 20s)', loadTimeMs: r.loadTimeMs, resultCount: r.resultCount });
    }
  }
  return alerts;
}

function computeSearchRating(result) {
  const sec = result.loadTimeMs / 1000;
  const isSuccess = (result.resultCount || 0) > 0;
  const isFlight = !!result.sector;
  const isDom = result.scenarioType === 'domestic';

  // SPF = SearchPulse Failure — automation issue, not Etrav platform issue
  // Conditions: 0.0s duration + FAILED status + form never submitted (no results URL)
  const url = result.searchUrl || '';
  const formSubmitted = isFlight
    ? (url.includes('/flights/oneway') || url.includes('/flights/roundtrip'))
    : url.includes('/hotels/search-results');
  if (sec === 0 && result.searchStatus === 'FAILED' && !formSubmitted) return 'SPF';
  if (result.searchStatus === 'AUTOSUGGEST_DOWN') return 'FAILURE!!!'; // Etrav issue — escalate

  if (!isSuccess || sec === 0 || sec >= 100) return 'FAILURE!!!';
  if (isFlight) {
    if (isDom) {
      if (sec <= 10) return 'PERFECT';
      if (sec <= 20) return 'MEDIAN';
      if (sec <= 30) return 'DELAY';
      return 'CRITICAL';
    } else {
      if (sec <= 20) return 'PERFECT';
      if (sec <= 30) return 'MEDIAN';
      if (sec <= 40) return 'DELAY';
      return 'CRITICAL';
    }
  } else {
    if (sec <= 20) return 'PERFECT';
    if (sec <= 45) return 'MEDIAN';
    if (sec <= 50) return 'DELAY';
    return 'CRITICAL';
  }
}

async function writeSearchQualitySignal(pulseData) {
  const signal = {
    pulseId: pulseData.pulseId,
    timestamp: getLocalTimestamp(),
    overallHealth: pulseData.overallHealth,
    criticalAlerts: pulseData.criticalAlerts || [],
    apiHealthSignals: pulseData.apiHealthSignals,
    flightSummary: pulseData.flightPulses.map(p => ({
      label: p.label, status: p.searchStatus,
      resultCount: p.resultCount, loadTimeMs: p.loadTimeMs,
      filtersWorking: p.filtersWorking, apiErrors: p.apiErrors,
    })),
    hotelSummary: pulseData.hotelPulses.map(p => ({
      label: p.label, status: p.searchStatus,
      resultCount: p.resultCount, loadTimeMs: p.loadTimeMs,
      filtersWorking: p.filtersWorking, apiErrors: p.apiErrors,
    })),
  };
  const sigPath = path.join(__dirname, '..', 'state', 'searchQualitySignal.json');
  fs.writeFileSync(sigPath, JSON.stringify(signal, null, 2));
}

async function runSearchPulseEngine() {
  // FIX 5: Skip if another pulse is already running
  if (_pulseRunning) {
    logger.info('[PULSE] Skipped — previous pulse still running');
    return { success: false, skipped: true, reason: 'pulse_already_running' };
  }
  _pulseRunning = true;
  try {
    return await _runSearchPulseEngineInternal();
  } finally {
    _pulseRunning = false;
  }
}

async function _runSearchPulseEngineInternal() {
  const { resetSessionTokens, getSessionTokens, getSessionEvalModes } = require('../utils/tokenOptimizer');
  const { writeMetrics } = require('../utils/metricsWriter');
  resetSessionTokens();

  const pulseId = generatePulseId();
  const startTime = new Date();
  const pulseData = {
    pulseId,
    startTime,
    flightPulses: [],
    hotelPulses: [],
    overallHealth: 'UNKNOWN',
    apiHealthSignals: [],
  };

  logger.info(`[PULSE] Search Pulse starting — ${pulseId}`);

  let browser = null;

  try {
    // Load trends + mirrors
    const trendData = trendCache.read();

    // Pick what to search this pulse
    const { flightSearches, hotelSearches } = pickPulseScenarios(trendData);

    // Launch browser + login (always headless for searches)
    const browserResult = await browserModule.launch();
    browser = browserResult.browser;
    const page = browserResult.page;

    await login.authenticate(page);

    // Quick health check: verify Etrav search page loads and form is responsive
    // If the autosuggest API is down, skip this pulse to avoid wasting time
    try {
      await page.goto('https://new.etrav.in/flights', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('input[placeholder="Where From ?"], input.react-autosuggest__input', { timeout: 15000 });
      await page.waitForTimeout(1000);
      // Test autosuggest by typing a common city
      const testInput = await page.$('input[placeholder="Where From ?"]');
      if (testInput) {
        await testInput.click({ force: true });
        await page.waitForTimeout(200);
        await testInput.type('DEL', { delay: 80 });
        // Wait for suggestions
        let suggestionsOk = false;
        try {
          await page.waitForSelector('.react-autosuggest__suggestion--first', { timeout: 8000 });
          suggestionsOk = true;
        } catch {}
        // Clear the test input
        await testInput.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        if (!suggestionsOk) {
          logger.warn('[PULSE] HEALTH CHECK FAILED: Etrav autosuggest API not responding — pausing this pulse');
          pulseData.overallHealth = 'ETRAV_DOWN';
          pulseData.endTime = new Date();
          pulseData.durationMs = pulseData.endTime - startTime;
          await browser.close();
          browser = null;
          return { success: false, error: 'Etrav search system appears down — autosuggest not responding', etravDown: true };
        }
        logger.info('[PULSE] Health check passed — Etrav autosuggest responding');
      }
    } catch (hcErr) {
      logger.warn('[PULSE] HEALTH CHECK FAILED: Could not load Etrav flights page — ' + hcErr.message);
      pulseData.overallHealth = 'ETRAV_DOWN';
      if (browser) { try { await browser.close(); } catch {} }
      browser = null;
      return { success: false, error: 'Etrav flights page not loading — ' + hcErr.message, etravDown: true };
    }

    // Run all 4 searches in PARALLEL (Flight DOM + Flight INTL + Hotel DOM + Hotel INTL).
    // Each search creates its own recording browser context, so they don't share DOM state.
    // Pulse cycle time ≈ max(individual search time) ≈ 60-90s, allowing 1 search/min/engine.
    async function runFlightWithRecording(flightScenario) {
      let result;
      let recorder = null;
      try {
        recorder = await createRecordingPage(browser, page, String(Math.floor(10000 + Math.random() * 90000)), 'https://new.etrav.in/flights');
        result = await runFlightSearchPulse((recorder && recorder.recPage) || page, flightScenario, pulseId);
        try {
          await ((recorder && recorder.recPage) || page).waitForSelector('.accordion_container, .one_way_card, .round_trip_card', { timeout: 15000 });
        } catch { /* cards may not appear for zero-result searches */ }
        await ((recorder && recorder.recPage) || page).waitForTimeout(5000);
        const mp4Path = await recorder.finalize();
        if (mp4Path) result.recordingPath = mp4Path;
        logger.info('[RECORDER] Flight recording saved for ' + (result.sector || '?'));
      } catch (recErr) {
        logger.error('[RECORDER] Flight recording failed: ' + recErr.message);
        if (recorder) await recorder.finalize().catch(function() {});
        // Fallback: run on a fresh recording context (NOT the shared main page — would conflict in parallel)
        if (!result) {
          try {
            const recFb = await createRecordingPage(browser, page, String(Math.floor(10000 + Math.random() * 90000)), 'https://new.etrav.in/flights');
            result = await runFlightSearchPulse(recFb.recPage, flightScenario, pulseId);
            await recFb.finalize().catch(() => {});
          } catch (fbErr) {
            result = {
              searchId: String(Math.floor(10000 + Math.random() * 90000)),
              label: flightScenario.label || (flightScenario.from + '->' + flightScenario.to),
              scenarioId: flightScenario.id,
              scenarioType: flightScenario.type || 'domestic',
              sector: (flightScenario.from || '') + '→' + (flightScenario.to || ''),
              searchStatus: 'FAILED',
              resultCount: 0,
              loadTimeMs: 0,
              error: 'Recording context creation failed: ' + fbErr.message,
              failureReason: 'AUTOMATION: Could not create browser context for parallel search.',
              actions: []
            };
          }
        }
      }
      return result;
    }

    async function runHotelWithRecording(hotelScenario) {
      let hotelResult;
      let recorderH = null;
      try {
        recorderH = await createRecordingPage(browser, page, String(Math.floor(10000 + Math.random() * 90000)), 'https://new.etrav.in/hotels');
        hotelResult = await runHotelSearchPulse((recorderH && recorderH.recPage) || page, hotelScenario, pulseId);

        // Wait for substantial hotel results to render (not just 1-2 skeleton cards) so the
        // recording captures the actual loaded state. Three checks in sequence:
        // 1) At least 5 hotel cards visible (or all that loaded for low-result destinations)
        // 2) Filter sidebar skeleton loaders are gone (no more [class*="skeleton"] visible)
        // 3) Then 8s hold for any final renders (price load, image load, etc.)
        try {
          await ((recorderH && recorderH.recPage) || page).waitForFunction(() => {
            // Count actual hotel cards that have content (not empty skeleton placeholders)
            const cards = document.querySelectorAll('[class*="hotel-card"], [class*="hotel_card"], [class*="property-card"]');
            const realCards = Array.from(cards).filter(c => {
              const text = (c.textContent || '').trim();
              return text.length > 50; // skeleton has tiny/empty text
            });
            // Also accept "no results" page as a valid stopping point
            const bodyText = document.body.innerText || '';
            const noResults = /no hotels found|no results|0\s*hotels|showing\s*\(0\)/i.test(bodyText);
            // Wait until either: ≥5 real cards visible, OR no-results page shown
            return realCards.length >= 5 || noResults;
          }, { timeout: 25000 });
        } catch {
          // Soft timeout — continue with whatever rendered
        }

        // Also wait for filter skeleton loaders to disappear
        try {
          await ((recorderH && recorderH.recPage) || page).waitForFunction(() => {
            const skeletons = document.querySelectorAll('[class*="skeleton" i], [class*="loader" i], [class*="placeholder" i]');
            const visibleSkeletons = Array.from(skeletons).filter(s => s.offsetParent !== null);
            return visibleSkeletons.length === 0;
          }, { timeout: 10000 });
        } catch {
          // Skeletons may persist for some destinations — don't block
        }

        // Final 8s hold so the video shows the fully rendered results page
        await ((recorderH && recorderH.recPage) || page).waitForTimeout(8000);
        const mp4Path = await recorderH.finalize();
        if (mp4Path) hotelResult.recordingPath = mp4Path;
        logger.info('[RECORDER] Hotel recording saved for ' + (hotelResult.destination || '?'));
      } catch (recErr) {
        logger.error('[RECORDER] Hotel recording failed: ' + recErr.message);
        if (recorderH) await recorderH.finalize().catch(function() {});
        if (!hotelResult) {
          try {
            const recFb = await createRecordingPage(browser, page, String(Math.floor(10000 + Math.random() * 90000)), 'https://new.etrav.in/hotels');
            hotelResult = await runHotelSearchPulse(recFb.recPage, hotelScenario, pulseId);
            await recFb.finalize().catch(() => {});
          } catch (fbErr) {
            hotelResult = {
              searchId: String(Math.floor(10000 + Math.random() * 90000)),
              label: hotelScenario.label || hotelScenario.destination,
              scenarioId: hotelScenario.id,
              scenarioType: hotelScenario.type || 'domestic',
              destination: hotelScenario.destination,
              searchStatus: 'FAILED',
              resultCount: 0,
              loadTimeMs: 0,
              error: 'Recording context creation failed: ' + fbErr.message,
              failureReason: 'AUTOMATION: Could not create browser context for parallel search.',
              actions: []
            };
          }
        }
      }
      return hotelResult;
    }

    // Build promises for ALL searches with STAGGERED starts
    // Staggering by 8s prevents all 4 searches from hitting heavy CPU operations
    // (pax dropdown SVG clicks, date pickers) at the same instant — eliminates the
    // "Flight pax set: actual 0A 0C 0I" failures caused by CPU contention.
    // Total pulse time = (4-1)*8s + max(individual time) ≈ 90-110s instead of 60s,
    // but accuracy is preserved (per CEO guidance: prioritize accuracy over speed).
    const STAGGER_MS = 8000;
    const allScenarios = [
      ...flightSearches.map(s => ({ kind: 'flight', scenario: s })),
      ...(hotelSearches || []).map(s => ({ kind: 'hotel', scenario: s }))
    ];

    logger.info('[PULSE] Running ' + flightSearches.length + ' flight + ' + (hotelSearches||[]).length + ' hotel searches in PARALLEL (staggered ' + STAGGER_MS/1000 + 's)');

    // MEMORY-AWARE execution: run at most `MAX_PARALLEL_SEARCHES` searches at a
    // time. On Railway (512MB), set MAX_PARALLEL_SEARCHES=1 to serialize —
    // Chromium + ffmpeg + recording all fighting for the same 512MB causes OOM
    // kills (witnessed: ffmpeg "Killed" mid-MP4, Playwright "Target crashed").
    // Default 4 retains existing behavior for local dev.
    const maxParallel = Math.max(1, parseInt(process.env.MAX_PARALLEL_SEARCHES || '4', 10));
    logger.info('[PULSE] Running ' + allScenarios.length + ' searches with concurrency=' + maxParallel + ' (stagger ' + STAGGER_MS/1000 + 's)');
    const parallelResults = [];
    for (let batchStart = 0; batchStart < allScenarios.length; batchStart += maxParallel) {
      const batch = allScenarios.slice(batchStart, batchStart + maxParallel);
      const batchPromises = batch.map((item, idx) => {
        return new Promise(resolve => setTimeout(resolve, idx * STAGGER_MS))
          .then(() => item.kind === 'flight' ? runFlightWithRecording(item.scenario) : runHotelWithRecording(item.scenario));
      });
      const batchResults = await Promise.allSettled(batchPromises);
      for (const r of batchResults) parallelResults.push(r);
    }

    // Split results back into flight/hotel arrays based on the original allScenarios order
    for (let i = 0; i < allScenarios.length; i++) {
      const item = allScenarios[i];
      const r = parallelResults[i];
      const targetArray = item.kind === 'flight' ? pulseData.flightPulses : pulseData.hotelPulses;
      if (r.status === 'fulfilled') {
        targetArray.push(r.value);
      } else {
        logger.error('[PULSE] ' + item.kind + ' promise rejected: ' + (r.reason?.message || r.reason));
        const fallback = {
          searchId: String(Math.floor(10000 + Math.random() * 90000)),
          label: item.scenario.label,
          scenarioType: item.scenario.type || 'domestic',
          searchStatus: 'FAILED',
          resultCount: 0,
          loadTimeMs: 0,
          failureReason: 'PROMISE REJECTED: ' + (r.reason?.message || 'unknown'),
          actions: []
        };
        if (item.kind === 'flight') {
          fallback.sector = (item.scenario.from || '') + '→' + (item.scenario.to || '');
        } else {
          fallback.destination = item.scenario.destination;
        }
        targetArray.push(fallback);
      }
    }

    // Calculate health
    pulseData.overallHealth = calculatePulseHealth(pulseData);
    pulseData.apiHealthSignals = extractApiSignals(pulseData);
    pulseData.criticalAlerts = buildCriticalAlerts(pulseData);
    if (pulseData.criticalAlerts.length > 0) {
      logger.warn('[PULSE] CRITICAL ALERTS: ' + pulseData.criticalAlerts.map(a => '[' + a.severity + '] ' + a.message).join(' | '));
    }

    // ── CMT ESCALATION PHASE ─────────────────────────────────────────
    // After all searches complete, escalate CRITICAL/FAILURE to Etrav CMT.
    // ONLY escalate genuine search failures (search submitted but returned bad results).
    // Skip automation failures (form didn't submit, button not found, element outside viewport).
    const cmtEnabled = settings.CMT_ESCALATION_ENABLED === 'true';
    if (cmtEnabled) {
      const allResults = [...pulseData.flightPulses, ...pulseData.hotelPulses];
      const toEscalate = allResults.filter(r => {
        const rating = computeSearchRating(r);
        if (!['CRITICAL', 'FAILURE!!!'].includes(rating)) return false;
        // Never escalate SPF (SearchPulse Failure) — automation issues are not Etrav's problem
        if (rating === 'SPF') return false;
        // Only escalate if the search actually submitted (URL changed to results page)
        // Skip automation failures where the form never submitted (0.0s, URL = /flights or empty)
        const url = r.searchUrl || '';
        const searchSubmitted = url.includes('/flights/oneway') || url.includes('/flights/roundtrip') || url.includes('/hotels/search-results');
        // Escalate AUTOSUGGEST_DOWN even if form didn't submit — it's an Etrav platform issue
        if (r.searchStatus === 'AUTOSUGGEST_DOWN') return true;
        if (!searchSubmitted) {
          logger.info('[CMT] Skipping automation failure for ' + (r.sector || r.destination || '?') + ' — form never submitted (not Etrav issue)');
          return false;
        }
        return true;
      });

      if (toEscalate.length > 0) {
        logger.info(`[PULSE] CMT Escalation: ${toEscalate.length} search(es) with CRITICAL/FAILURE — starting escalation`);
        let cmtEscalationCount = 0;
        for (const result of toEscalate) {
          if (cmtEscalationCount >= MAX_ESCALATIONS_PER_PULSE) {
            logger.info(`[PULSE] CMT Escalation: hit pulse limit (${MAX_ESCALATIONS_PER_PULSE}), stopping`);
            break;
          }
          const rating = computeSearchRating(result);
          try {
            // For searches with a valid results URL, navigate to it
            // For AUTOSUGGEST_DOWN / empty URL, navigate to the base page instead
            const navUrl = (result.searchUrl && (result.searchUrl.includes('/flights/oneway') || result.searchUrl.includes('/flights/roundtrip') || result.searchUrl.includes('/hotels/search-results')))
              ? result.searchUrl
              : (result.sector ? 'https://new.etrav.in/flights' : 'https://new.etrav.in/hotels');
            logger.info(`[PULSE] CMT: Escalating ${result.sector || result.destination} (${rating}) — nav to ${navUrl.slice(0, 80)}...`);
            await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(5000);
            const esc = await escalateToEtravCMT(page, result, rating, cmtEscalationCount);
            result.cmtEscalation = esc;
            if (esc.escalated) cmtEscalationCount++;
          } catch (escErr) {
            logger.error(`[PULSE] CMT: Failed to escalate ${result.sector || result.destination}: ${escErr.message}`);
            result.cmtEscalation = { escalated: false, reason: 'nav_error: ' + escErr.message };
          }
        }
        logger.info(`[PULSE] CMT Escalation complete: ${cmtEscalationCount} ticket(s) raised`);
      }
    }

    pulseData.endTime = new Date();
    pulseData.durationMs = pulseData.endTime - startTime;

    await browser.close();
    browser = null;

    // Build report
    const reportPath = await searchPulseReportBuilder.build(pulseData, trendData);
    pulseData.reportPath = reportPath;

    // Write quality signal
    await writeSearchQualitySignal(pulseData);

    // Write metrics for dashboard
    const tokens = getSessionTokens();
    const evalModes = getSessionEvalModes();
    const allResults = [...pulseData.flightPulses, ...pulseData.hotelPulses];
    const totalLoad = allResults.reduce((s, r) => s + (r.loadTimeMs || 0), 0);
    const avgLoadMs = allResults.length > 0 ? Math.round(totalLoad / allResults.length) : 0;
    const filterStats = { total: 0, passed: 0 };
    for (const r of allResults) {
      for (const v of Object.values(r.filtersWorking || {})) {
        filterStats.total++;
        if (v === true) filterStats.passed++;
      }
    }
    const filterPassRate = filterStats.total > 0 ? Math.round((filterStats.passed / filterStats.total) * 100) : 100;
    const apiErrors = allResults.reduce((s, r) => s + (r.apiErrors || 0), 0);
    const zeroResultRoutes = allResults.filter(r => r.resultCount === 0).map(r => r.label);

    await writeMetrics({
      engineType: 'searchpulse',
      overallHealth: pulseData.overallHealth,
      avgLoadTimeMs: avgLoadMs,
      flightResultCount: pulseData.flightPulses.reduce((s, r) => s + (r.resultCount || 0), 0),
      hotelResultCount: pulseData.hotelPulses.reduce((s, r) => s + (r.resultCount || 0), 0),
      flightAvgLoadMs: pulseData.flightPulses.length > 0 ? Math.round(pulseData.flightPulses.reduce((s, r) => s + (r.loadTimeMs || 0), 0) / pulseData.flightPulses.length) : 0,
      hotelAvgLoadMs: pulseData.hotelPulses.length > 0 ? Math.round(pulseData.hotelPulses.reduce((s, r) => s + (r.loadTimeMs || 0), 0) / pulseData.hotelPulses.length) : 0,
      flightSearches: pulseData.flightPulses.map(r => ({ searchId: r.searchId || '', label: r.label, results: r.resultCount || 0, loadTimeMs: r.loadTimeMs || 0, status: r.searchStatus || 'UNKNOWN', type: r.scenarioType || 'domestic', url: r.searchUrl || '', sector: r.sector || '', searchDate: r.searchDate || '', paxCount: r.paxCount || '', cabinClass: r.cabinClass || '', searchType: r.searchType || '', returnOffset: r.returnOffset || 0, airlineCount: r.airlineCount || 0, screenshotPath: r.screenshotPath || '', escalated: r.cmtEscalation?.escalated ? true : false, failureReason: r.failureReason || '', recordingPath: r.recordingPath || '', rating: computeSearchRating(r) })),
      hotelSearches: pulseData.hotelPulses.map(r => ({ searchId: r.searchId || '', label: r.label, results: r.resultCount || 0, loadTimeMs: r.loadTimeMs || 0, status: r.searchStatus || 'UNKNOWN', type: r.scenarioType || 'domestic', url: r.searchUrl || '', destination: r.destination || '', searchDate: r.searchDate || '', nights: r.nights || 0, rooms: r.rooms || 0, paxCount: r.paxCount || '', starFilter: r.starFilter || '', screenshotPath: r.screenshotPath || '', escalated: r.cmtEscalation?.escalated ? true : false, failureReason: r.failureReason || '', recordingPath: r.recordingPath || '', rating: computeSearchRating(r) })),
      filterPassRate,
      apiErrors,
      zeroResultRoutes,
      criticalAlerts: pulseData.criticalAlerts || [],
      delayedRoutes: allResults.filter(r => r.loadTimeMs > 20000).map(r => ({ route: r.label, loadTimeMs: r.loadTimeMs })),
      durationMs: pulseData.durationMs,
      tokensInput: tokens.input,
      tokensOutput: tokens.output,
      tokensUsed: tokens.total,
      apiCalls: tokens.calls,
      evalsFast: evalModes.fast,
      evalsStandard: evalModes.standard,
      evalsDeep: evalModes.deep,
      reportPath,
    });

    logger.info(`[PULSE] Complete — Health: ${pulseData.overallHealth} — ${reportPath}`);
    return { success: true, pulseData, reportPath };
  } catch (err) {
    logger.error(`[PULSE] Engine failed: ${err.message}`);
    pulseData.overallHealth = 'ENGINE_FAILURE';
    return { success: false, error: err.message };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

module.exports = { runSearchPulseEngine };
