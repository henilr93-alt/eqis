const logger = require('../utils/logger');
const screenshotter = require('../utils/screenshotter');
const { evaluateSearchPulse } = require('./searchPulseEvaluator');
const {
  fillAutosuggest, pickReactDate, selectTripType,
  clickSearchFlight, countFlightResults, getFlightResultCountFromText,
  fillFlightPax,
  toggleRoundTripFare,
  dismissAllOverlays,
  FLIGHT_RESULT_SELECTOR,
} = require('../utils/etravFormHelpers');

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function runFlightSearchPulse(page, scenario, pulseId) {
  // Compute search date upfront from scenario params (before try block so it's always set)
  const depDate = addDays(new Date(), scenario.dateOffsetDays || scenario.dateOffset || 7);
  const searchId = String(Math.floor(10000 + Math.random() * 90000)); // unique 5-digit ID

  const result = {
    searchId,
    label: scenario.label || `${scenario.from}->${scenario.to}`,
    scenarioId: scenario.id,
    scenarioSource: scenario.source || 'prebuilt',
    scenarioType: scenario.type || 'domestic',
    mirrorReason: scenario.mirrorReason || null,
    searchStatus: 'PENDING',
    resultCount: 0,
    loadTimeMs: 0,
    searchUrl: '',
    airlineCount: 0,
    sector: (scenario.from || '') + '→' + (scenario.to || ''),
    searchDate: depDate.toISOString().split('T')[0],
    paxCount: scenario.passengers ? (scenario.passengers.adults || 1) + 'A ' + (scenario.passengers.children || 0) + 'C ' + (scenario.passengers.infants || 0) + 'I' : '1A',
    cabinClass: scenario.cabinClass || 'Economy',
    searchType: scenario.tripType || 'one-way',
    returnOffset: scenario.returnOffset || 0,
    filtersWorking: {},
    apiErrors: 0,
    apiErrorDetail: null,
    screenshot: null,
    evaluation: null,
    actions: [],
  };

  try {
    logger.info(`[PULSE] Flight search: ${scenario.from}->${scenario.to} | ${scenario.cabinClass}`);

    // Navigate to flights form — skip if already there (recording pre-navigation)
    const currentUrl = page.url();
    if (!currentUrl.includes('/flights') || currentUrl.includes('/flights/oneway') || currentUrl.includes('/flights/roundtrip')) {
      await page.goto('https://new.etrav.in/flights', { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    // Scroll to top to reset viewport position
    await page.evaluate(() => window.scrollTo(0, 0));
    // Wait for the EXACT autosuggest input to render (takes ~8s on Etrav)
    await page.waitForSelector('input[placeholder="Where From ?"], input.react-autosuggest__input', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000); // Extra wait for full React hydration

    // Dismiss ALL modals and overlays that could block form elements
    await page.evaluate(() => {
      ['.react-responsive-modal-root', '.react-responsive-modal-container', '.react-responsive-modal-overlay',
       '[class*="modal"]', '[class*="popup"]', '[class*="overlay"]'].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          if (el.id !== 'root' && el.id !== 'portal-root') el.remove();
        });
      });
      window.scrollTo(0, 0);
    });

    // Clear leftover DOM stability globals from previous search on this page
    await page.evaluate(() => {
      delete window._domStableStart;
      delete window._lastDomChange;
      if (window._domObserver) { window._domObserver.disconnect(); delete window._domObserver; }
    });

    // Select trip type (one-way by default)
    await selectTripType(page, scenario.tripType || 'one-way');
    result.actions.push(`Trip type: ${scenario.tripType || 'one-way'}`);

    // For round-trip searches: read pre-assigned target from scenario (set by pulsePicker)
    // pulsePicker assigns roundTripFareShouldBeChecked sequentially per pulse to avoid
    // race conditions when Flight DOM + Flight INTL run in parallel.
    if (scenario.tripType === 'round-trip' && typeof scenario.roundTripFareShouldBeChecked === 'boolean') {
      try {
        await page.waitForTimeout(500);
        const toggleResult = await toggleRoundTripFare(page, scenario.roundTripFareShouldBeChecked);
        result.actions.push('RoundTrip Fare ticker: target=' + (scenario.roundTripFareShouldBeChecked ? 'checked' : 'unchecked') + ' result=' + (toggleResult.actualAfter ? 'checked' : 'unchecked') + ' [count=' + (scenario.roundTripCounter || 0) + ']');
        result.roundTripFareChecked = toggleResult.actualAfter;
      } catch (rtErr) {
        logger.warn('[PULSE] RoundTrip Fare toggle failed: ' + rtErr.message);
      }
    }


    // Origin
    const originOk = await fillAutosuggest(page, 'Where From ?', scenario.fromCity || scenario.from);
    result.actions.push(`Origin: ${scenario.fromCity || scenario.from} [${originOk ? 'OK' : 'FAIL'}]`);

    // Destination
    const destOk = await fillAutosuggest(page, 'Where To ?', scenario.toCity || scenario.to);
    result.actions.push(`Destination: ${scenario.toCity || scenario.to} [${destOk ? 'OK' : 'FAIL'}]`);

    // FIX 3: Bail out early if origin or destination autosuggest failed
    if (!originOk || !destOk) {
      result.searchStatus = 'AUTOSUGGEST_DOWN';
      result.error = 'Flight autosuggest failed: ' + (!originOk ? 'origin' : '') + (!originOk && !destOk ? ' + ' : '') + (!destOk ? 'destination' : '');
      result.failureReason = 'ETRAV ISSUE: Autosuggest API did not return valid suggestions for ' + (!originOk ? scenario.from : scenario.to) + '. Etrav platform issue or rate-limit.';
      logger.error('[PULSE] ' + result.error);
      result.screenshot = await screenshotter.takeStep(page, pulseId, 'flight-pulse-' + scenario.id);
      if (result.screenshot) {
        const pathMod = require('path');
        result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'flight-pulse-' + scenario.id + '.png');
      }
      return result;
    }

    // Departure date (depDate already computed above before try block)
    const depOk = await pickReactDate(page, 0, depDate);
    result.actions.push(`Departure: ${depDate.toDateString()} [${depOk ? 'OK' : 'FAIL'}]`);

    // Dismiss calendar/overlays after departure date selection
    await dismissAllOverlays(page);

    // Return date (if round-trip)
    if ((scenario.tripType === 'round-trip' || scenario.tripType === 'open-jaw') && (scenario.returnOffset || scenario.returnOffsetDays)) {
      const retDays = (scenario.dateOffsetDays || scenario.dateOffset || 7) + (scenario.returnOffset || scenario.returnOffsetDays || 7);
      const retDate = addDays(new Date(), retDays);
      const retOk = await pickReactDate(page, 1, retDate);
      result.actions.push(`Return: ${retDate.toDateString()} [${retOk ? 'OK' : 'FAIL'}]`);
      // Dismiss calendar after return date
      await dismissAllOverlays(page);
    }

    // Dismiss all overlays before pax/cabin fill to ensure nothing blocks the traveller dropdown
    await dismissAllOverlays(page);

    // Set passenger count (adults, children, infants)
    if (scenario.passengers) {
      const paxOk = await fillFlightPax(page, scenario.passengers, scenario.cabinClass);
      result.actions.push(`Passengers: ${scenario.passengers.adults}A ${scenario.passengers.children}C ${scenario.passengers.infants}I | Cabin: ${scenario.cabinClass} [${paxOk ? 'OK' : 'FAIL'}]`);
    }

    // Read back actual pax/cabin from the form label to verify what was actually set
    try {
      const actualLabel = await page.evaluate(() => {
        const divs = document.querySelectorAll('div');
        for (const d of divs) {
          if (/^\d+ Traveller/.test(d.textContent.trim()) && d.children.length === 0) return d.textContent.trim();
        }
        return null;
      });
      if (actualLabel) {
        result.actions.push('Form shows: ' + actualLabel);
        // Update cabinClass from form (keep detailed paxCount "XA YC ZI" from scenario)
        const m = actualLabel.match(/(\d+) Traveller.*?,\s*(.*)/);
        if (m) {
          result.cabinClass = m[2].trim();
        }
      }
    } catch { /* readback optional */ }

    await page.waitForTimeout(500);

    // Dismiss all overlays before clicking search — ensure nothing blocks the button
    await dismissAllOverlays(page);

    // Scroll search button into view before clicking (fixes "element outside viewport" error)
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /Search Flight/i.test(b.textContent));
      if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await page.waitForTimeout(300);

    // Click search
    const searchClicked = await clickSearchFlight(page);
    result.actions.push(`Search clicked: ${searchClicked}`);

    if (!searchClicked) {
      // Check if autosuggest fields were filled — if not, it's an autosuggest API issue (escalate to tech team)
      const fieldsEmpty = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input.react-autosuggest__input');
        return Array.from(inputs).every(i => !i.value || i.value === '-');
      });
      result.searchStatus = fieldsEmpty ? 'AUTOSUGGEST_DOWN' : 'FAILED';
      result.error = fieldsEmpty ? 'Autosuggest API not responding — fields empty' : 'Could not click Search Flight button';
      result.failureReason = fieldsEmpty
        ? 'ETRAV ISSUE: Autosuggest API did not return suggestions for origin/destination. This is an Etrav platform issue affecting all agents.'
        : 'AUTOMATION: Search button not clickable — likely a UI overlay or rendering issue. Not an Etrav platform problem.';
      logger.error(`[PULSE] ${result.error}`);
      result.screenshot = await screenshotter.takeStep(page, pulseId, `flight-pulse-${scenario.id}`);
      if (result.screenshot) {
        const path = require('path');
        result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', `flight-pulse-${scenario.id}.png`);
      }
      return result;
    }

    // Start duration timer from the moment search button is clicked
    const searchSubmitTime = Date.now();

    // Quick check: wait up to 10s for URL to change
    try {
      await page.waitForFunction(() => {
        return /flights\/(oneway|roundtrip)/i.test(window.location.href);
      }, { timeout: 10000 });
    } catch {
      result.searchUrl = page.url();
      if (!/flights\/(oneway|roundtrip)/i.test(result.searchUrl)) {
        result.searchStatus = 'FAILED';
        result.error = 'Search did not submit — URL stayed on form page';
        result.failureReason = 'PRE-SEARCH: Form was filled but search did not navigate to results page. Origin/destination autosuggest may have failed silently, or the search button click did not trigger form submission.';
        logger.error(`[PULSE] Flight ${scenario.from}->${scenario.to}: form did not submit (URL: ${result.searchUrl})`);
        result.screenshot = await screenshotter.takeStep(page, pulseId, `flight-pulse-${scenario.id}`);
        if (result.screenshot) {
          const path = require('path');
          result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', `flight-pulse-${scenario.id}.png`);
        }
        return result;
      }
    }

    // URL changed — search submitted successfully

    // ─────────────────────────────────────────────────────────────────────
    // NEW DURATION RULE (Flights only): Track Etrav's loading progress bar.
    //
    // Etrav shows a horizontal progress bar (.progress-bar-container > .progress-bar)
    // at the top of the results page while flights are being fetched from the API.
    // - Timer STARTS: when Search button is clicked (already set above)
    // - Timer STOPS: 1 second after the loading bar DISAPPEARS from the DOM
    // - FAILURE: if loading bar never appears (Etrav not rendering search properly)
    // - FAILURE: if loading bar never disappears within 60s (search hung)
    // ─────────────────────────────────────────────────────────────────────

    // Step 1: Wait for the loading bar to APPEAR (max 8s)
    let loaderAppeared = false;
    try {
      await page.waitForFunction(() => {
        const bar = document.querySelector('.progress-bar-container');
        return bar && bar.offsetParent !== null;
      }, { timeout: 8000 });
      loaderAppeared = true;
      result.actions.push('Loading bar appeared');
    } catch {
      // Loading bar never appeared — Etrav did not render the loading UI
      result.searchStatus = 'FAILED';
      result.error = 'Loading bar never appeared after URL change';
      result.failureReason = 'ETRAV ISSUE: Search submitted (URL changed) but the loading progress bar never appeared. Etrav may have skipped its API loading sequence or the page rendering failed.';
      result.loadTimeMs = Date.now() - searchSubmitTime;
      result.searchUrl = page.url();
      logger.error('[PULSE] Flight ' + scenario.from + '->' + scenario.to + ': loading bar never appeared');
      result.screenshot = await screenshotter.takeStep(page, pulseId, 'flight-pulse-' + scenario.id);
      if (result.screenshot) {
        const pathMod = require('path');
        result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'flight-pulse-' + scenario.id + '.png');
      }
      return result;
    }

    // Step 2: Wait for the loading bar to DISAPPEAR (max 60s)
    let loaderGone = false;
    try {
      await page.waitForFunction(() => {
        const bar = document.querySelector('.progress-bar-container');
        // Bar is "gone" if removed from DOM OR hidden via CSS
        return !bar || bar.offsetParent === null;
      }, { timeout: 60000 });
      loaderGone = true;
      result.actions.push('Loading bar disappeared');
    } catch {
      // Loading bar never went away — search hung
      result.searchStatus = 'FAILED';
      result.error = 'Loading bar still visible after 60s — search hung';
      result.failureReason = 'ETRAV ISSUE: Loading progress bar did not disappear within 60 seconds. Etrav API likely timed out or hung mid-search.';
      result.loadTimeMs = Date.now() - searchSubmitTime;
      result.searchUrl = page.url();
      logger.error('[PULSE] Flight ' + scenario.from + '->' + scenario.to + ': loading bar stuck > 60s');
      result.screenshot = await screenshotter.takeStep(page, pulseId, 'flight-pulse-' + scenario.id);
      if (result.screenshot) {
        const pathMod = require('path');
        result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'flight-pulse-' + scenario.id + '.png');
      }
      return result;
    }

    // Step 3: 1-second buffer after loading bar disappears (catches final DOM renders)
    await page.waitForTimeout(1000);

    // Timer STOPS: search click → loading bar disappeared + 1s buffer
    result.loadTimeMs = Date.now() - searchSubmitTime;
    result.actions.push('Duration: ' + (result.loadTimeMs / 1000).toFixed(1) + 's (loader appeared → loader gone + 1s buffer)');
    result.searchUrl = page.url();

    // Screenshot results
    const ssStepName = `flight-pulse-${scenario.id}`;
    result.screenshot = await screenshotter.takeStep(page, pulseId, ssStepName);
    // Construct file path for individual report (screenshotter saves to reports/journey/{pulseId}/screenshots/)
    if (result.screenshot) {
      const path = require('path');
      result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', `${ssStepName}.png`);
    }

    // Count results — prefer "Showing (N)" text, fall back to card count
    const textCount = await getFlightResultCountFromText(page);
    const cardCount = await countFlightResults(page);
    result.resultCount = textCount != null ? textCount : cardCount;
    result.actions.push(`Results: ${result.resultCount} (text=${textCount}, cards=${cardCount})`);

    // Check for API errors
    const apiCheck = await checkForApiErrors(page);
    result.apiErrors = apiCheck.count;
    result.apiErrorDetail = apiCheck.detail;

    // Count unique airlines shown in results
    // Etrav cards: .accordion_container with airline name as first text ("SpiceJet | SG 193...") and img src like SG.png
    try {
      result.airlineCount = await page.evaluate(() => {
        const cards = document.querySelectorAll('.accordion_container, .flight_search_result');
        const airlines = new Set();
        cards.forEach(card => {
          const text = (card.innerText || '').trim();
          // Primary: extract airline name from the first word/phrase before the pipe
          // Card text format: "SpiceJet | SG 193, SG 695 | Class: HR | 21:10 ..."
          const firstLine = text.split('\n')[0] || '';
          const airlineName = firstLine.split('|')[0].trim();
          if (airlineName && airlineName.length > 1 && airlineName.length < 25) {
            airlines.add(airlineName);
          }
          // Secondary: airline code from img src (e.g., SG.png, 6E.png)
          const imgs = card.querySelectorAll('img');
          imgs.forEach(img => {
            const fname = (img.src || '').split('/').pop().replace(/\.(png|jpg|svg|webp)$/i, '');
            if (fname && fname.length >= 2 && fname.length <= 3 && fname !== 'NoFlightIcon') {
              airlines.add(fname.toUpperCase());
            }
          });
        });
        return airlines.size || 0;
      });
    } catch(e) { result.airlineCount = 0; }

    result.searchStatus = result.resultCount === 0 ? 'ZERO_RESULTS'
      : result.apiErrors > 0 ? 'API_ERROR'
      : 'SUCCESS';

    // Vision evaluation — ONLY for zero-result or failed searches (saves ~90% tokens)
    // Successful searches already have result count + load time from DOM scraping
    if (result.screenshot && (result.resultCount === 0 || result.searchStatus === 'FAILED' || result.apiErrors > 0)) {
      result.evaluation = await evaluateSearchPulse(
        result.screenshot, 'flight_results', scenario,
        { resultCount: result.resultCount, loadTimeMs: result.loadTimeMs }
      );
    }

    logger.info(`[PULSE] Flight ${scenario.from}->${scenario.to}: ${result.searchStatus} | ${result.resultCount} results | ${result.loadTimeMs}ms`);
  } catch (err) {
    result.searchStatus = 'FAILED';
    result.error = err.message;
    result.failureReason = 'RUNTIME ERROR: ' + err.message;
    logger.error(`[PULSE] Flight search failed: ${scenario.id} - ${err.message}`);
    // Take screenshot on crash for tech team analysis
    try {
      result.screenshot = await screenshotter.takeStep(page, pulseId, `flight-pulse-${scenario.id}`);
      if (result.screenshot) {
        const path = require('path');
        result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', `flight-pulse-${scenario.id}.png`);
      }
    } catch { /* screenshot failed too — page may be crashed */ }
  }

  return result;
}

async function checkForApiErrors(page) {
  const errorPatterns = [
    '[class*="error-message"]', '[class*="api-error"]',
    '[class*="no-results"]', '[class*="try-again"]',
  ];
  let count = 0;
  const details = [];
  for (const pattern of errorPatterns) {
    try {
      const el = await page.$(pattern);
      if (el) {
        const text = await el.textContent();
        count++;
        details.push(text?.trim()?.slice(0, 100));
      }
    } catch { /* ignore */ }
  }
  return { count, detail: details.join(' | ') || null };
}

module.exports = { runFlightSearchPulse };