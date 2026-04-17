const logger = require('../utils/logger');
const screenshotter = require('../utils/screenshotter');
const { evaluateSearchPulse } = require('./searchPulseEvaluator');
const {
  fillAutosuggest, pickHotelDateRange, clickSearchHotels, countHotelResults,
  fillHotelPax,
  dismissAllOverlays,
} = require('../utils/etravFormHelpers');

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function runHotelSearchPulse(page, scenario, pulseId) {
  // Compute check-in date upfront from scenario params (before try block so it's always set)
  const checkinDate = addDays(new Date(), scenario.checkinOffsetDays || scenario.checkinOffset || 10);
  const checkoutDate = addDays(checkinDate, scenario.nights || 3);
  const searchId = String(Math.floor(10000 + Math.random() * 90000)); // unique 5-digit ID

  const result = {
    searchId,
    label: scenario.label || scenario.destination,
    scenarioId: scenario.id,
    scenarioSource: scenario.source || 'prebuilt',
    scenarioType: scenario.type || 'domestic',
    mirrorReason: scenario.mirrorReason || null,
    searchStatus: 'PENDING',
    resultCount: 0,
    loadTimeMs: 0,
    searchUrl: '',
    destination: scenario.destination || '',
    searchDate: checkinDate.toISOString().split('T')[0],
    nights: scenario.nights || 3,
    rooms: scenario.rooms || 1,
    paxCount: scenario.paxLabel || ((scenario.adultsPerRoom || 2) + 'A'),
    totalAdults: scenario.totalAdults || (scenario.adultsPerRoom || 2) * (scenario.rooms || 1),
    totalChildren: scenario.totalChildren || 0,
    roomPax: scenario.roomPax || [],
    starFilter: scenario.starFilter || '',
    filtersWorking: {},
    apiErrors: 0,
    apiErrorDetail: null,
    screenshot: null,
    evaluation: null,
    actions: [],
  };

  try {
    logger.info(`[PULSE] Hotel search: ${scenario.destination} | ${scenario.rooms}R | ${result.paxCount} | ${scenario.nights}N`);

    // Navigate to hotels page directly - using domcontentloaded to prevent timeouts
    // Hard refresh to clean page state
    // Navigate to hotels form — skip if already there (recording pre-navigation)
    const currentUrl = page.url();
    if (!currentUrl.includes('/hotels') || currentUrl.includes('/hotels/search-results')) {
      await page.goto('https://new.etrav.in/hotels', { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForSelector('input.react-autosuggest__input, input[placeholder="Hotel name or Destination"]', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000); // Extra wait for full React hydration

    // Dismiss ALL modals and overlays
    await page.evaluate(() => {
      ['.react-responsive-modal-root', '.react-responsive-modal-container', '.react-responsive-modal-overlay',
       '[class*="modal"]', '[class*="popup"]', '[class*="overlay"]'].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          if (el.id !== 'root' && el.id !== 'portal-root') el.remove();
        });
      });
      window.scrollTo(0, 0);
    });

    // Clear leftover DOM stability globals from previous search
    await page.evaluate(() => {
      delete window._domStableStart;
      delete window._lastDomChange;
      if (window._domObserver) { window._domObserver.disconnect(); delete window._domObserver; }
    });

    // Fill destination (react-autosuggest). Try multiple placeholder variants.
    let destOk = await fillAutosuggest(page, 'Hotel name or Destination', scenario.destination);
    if (!destOk) destOk = await fillAutosuggest(page, 'City or Hotel', scenario.destination);
    if (!destOk) destOk = await fillAutosuggest(page, 'Where to ?', scenario.destination);
    result.actions.push(`Destination: ${scenario.destination} [${destOk ? 'OK' : 'FAIL'}]`);

    // FIX 3: Bail out early if destination autosuggest failed — no point filling rest of form
    if (!destOk) {
      result.searchStatus = 'AUTOSUGGEST_DOWN';
      result.error = 'Hotel destination autosuggest failed after 3 attempts';
      result.failureReason = 'ETRAV ISSUE: Autosuggest API did not return valid suggestions for "' + scenario.destination + '". Either Etrav does not have this destination indexed, or the autosuggest API was rate-limited/unresponsive.';
      logger.error('[PULSE] ' + result.error);
      result.screenshot = await screenshotter.takeStep(page, pulseId, 'hotel-pulse-' + scenario.id);
      if (result.screenshot) {
        const path = require('path');
        result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'hotel-pulse-' + scenario.id + '.png');
      }
      return result;
    }

    // Pick check-in and check-out (checkinDate/checkoutDate already computed above before try block)
    const rangeOk = await pickHotelDateRange(page, checkinDate, checkoutDate);
    result.actions.push(`Check-in: ${checkinDate.toDateString()}, Check-out: ${checkoutDate.toDateString()} [${rangeOk ? 'OK' : 'FAIL'}]`);

    // Dismiss all overlays after date selection
    await dismissAllOverlays(page);

    // Set rooms and pax
    if (scenario.roomPax && scenario.roomPax.length > 0) {
      const paxOk = await fillHotelPax(page, scenario.rooms || 1, scenario.roomPax);
      const paxLabel = scenario.roomPax.map((r, i) => `R${i + 1}:${r.adults}A${r.children > 0 ? ' ' + r.children + 'C' : ''}`).join(' ');
      result.actions.push(`Rooms & Guests: ${scenario.rooms || 1}R — ${paxLabel} [${paxOk ? 'OK' : 'FAIL'}]`);
    }

    // Read back actual rooms/pax from the form to verify what was actually set
    try {
      const actualRoomLabel = await page.evaluate(() => {
        const divs = document.querySelectorAll('div');
        for (const d of divs) {
          const t = d.textContent.trim();
          if (/^\d+ Room/.test(t) && t.includes('Guest') && d.children.length <= 2) return t;
        }
        return null;
      });
      if (actualRoomLabel) {
        result.actions.push('Form shows: ' + actualRoomLabel);
        // Update rooms count from form (keep detailed paxCount per-room format from scenario)
        const rm = actualRoomLabel.match(/(\d+)\s*Room/);
        if (rm) result.rooms = parseInt(rm[1], 10);
      }
    } catch { /* readback optional */ }

    // Read back actual dates from the form
    try {
      const actualDates = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        const dates = {};
        inputs.forEach(inp => {
          const ph = inp.placeholder || '';
          const val = inp.value || '';
          if (ph.toLowerCase().includes('check') && ph.toLowerCase().includes('in')) dates.checkin = val;
          if (ph.toLowerCase().includes('check') && ph.toLowerCase().includes('out')) dates.checkout = val;
        });
        // Fallback: look for date display text
        if (!dates.checkin || !dates.checkout) {
          document.querySelectorAll('div').forEach(d => {
            const t = d.textContent.trim();
            if (/^\d{1,2}\s+\w{3}'\d{2}$/.test(t)) {
              if (!dates.checkin) dates.checkin = t;
              else if (!dates.checkout) dates.checkout = t;
            }
          });
        }
        return dates;
      });
      if (actualDates.checkout === '-' || !actualDates.checkout) {
        result.actions.push('WARNING: Checkout date not set on form');
      }
    } catch { /* readback optional */ }

    await page.waitForTimeout(500);

    // Dismiss all overlays before search
    await dismissAllOverlays(page);

    // Click search
    // Scroll search button into view before clicking
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /Search Hotel/i.test(b.textContent));
      if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await page.waitForTimeout(300);
    const searchClicked = await clickSearchHotels(page);
    result.actions.push(`Search clicked: ${searchClicked}`);

    if (!searchClicked) {
      const fieldsEmpty = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input.react-autosuggest__input');
        return Array.from(inputs).every(i => !i.value || i.value === '-');
      });
      result.searchStatus = fieldsEmpty ? 'AUTOSUGGEST_DOWN' : 'FAILED';
      result.error = fieldsEmpty ? 'Autosuggest API not responding — destination empty' : 'Could not click Search Hotels button';
      result.failureReason = fieldsEmpty
        ? 'ETRAV ISSUE: Autosuggest API did not return suggestions for hotel destination. This is an Etrav platform issue affecting all agents.'
        : 'AUTOMATION: Hotel search button not clickable — likely a UI overlay or rendering issue. Not an Etrav platform problem.';
      logger.error(`[PULSE] ${result.error}`);
      result.screenshot = await screenshotter.takeStep(page, pulseId, `hotel-pulse-${scenario.id}`);
      if (result.screenshot) {
        const path = require('path');
        result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', `hotel-pulse-${scenario.id}.png`);
      }
      return result;
    }

    // Search submitted. Start the REAL duration timer from here.
    const searchSubmitTime = Date.now();

    // Wait for URL to change to hotel search results page
    try {
      await page.waitForFunction(() => {
        return /hotels\/search-results/i.test(window.location.href);
      }, { timeout: 15000 });
    } catch {
      result.searchUrl = page.url();
      if (!/hotels\/search-results/i.test(result.searchUrl)) {
        result.searchStatus = 'FAILED';
        result.error = 'Hotel search did not submit — URL stayed on form page';
        result.failureReason = 'PRE-SEARCH: Form was filled but search did not navigate to results. Destination autosuggest may have failed silently.';
        logger.error(`[PULSE] Hotel ${scenario.destination}: form did not submit (URL: ${result.searchUrl})`);
        result.screenshot = await screenshotter.takeStep(page, pulseId, `hotel-pulse-${scenario.id}`);
        if (result.screenshot) {
          const path = require('path');
          result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', `hotel-pulse-${scenario.id}.png`);
        }
        return result;
      }
    }

    // Check if Etrav returned a crash page instead of results
    const isCrashPage = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      return bodyText.includes('Oops! Something went wrong') || bodyText.includes('An unexpected error occurred');
    });
    if (isCrashPage) {
      result.searchUrl = page.url();
      result.loadTimeMs = Date.now() - searchSubmitTime;
      result.searchStatus = 'FAILED';
      result.error = 'Etrav platform crash — "Oops! Something went wrong" error page';
      result.failureReason = 'ETRAV PLATFORM ERROR: Server returned crash page instead of search results. This is an Etrav infrastructure issue, not an automation failure.';
      logger.error('[PULSE] Hotel ' + scenario.destination + ': Etrav crash page detected');
      result.screenshot = await screenshotter.takeStep(page, pulseId, 'hotel-pulse-' + scenario.id);
      if (result.screenshot) {
        const path = require('path');
        result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'hotel-pulse-' + scenario.id + '.png');
      }
      return result;
    }

    // URL changed — hotel search submitted. Wait for first results to appear.
    // Use broadest possible detection: card selectors, text patterns, Book Now buttons, prices.
    try {
      await page.waitForFunction(() => {
        // CSS selectors for hotel cards (broad match)
        const cards = document.querySelectorAll(
          '[class*="hotel-card"], [class*="hotel_card"]:not([class*="skeleton"]), ' +
          '[class*="property-card"], [class*="property_card"], ' +
          '[class*="hotel-item"], [class*="hotel_item"], ' +
          '[class*="HotelCard"], [class*="hotelCard"], ' +
          '[class*="hotel_search"], [class*="hotel-search"], ' +
          '[class*="hotel_result"], [class*="hotel-result"]'
        );
        if (cards.length > 0) return true;
        // "Book Now" buttons — each hotel card has one
        const btns = document.querySelectorAll('button, a');
        let bookNow = 0;
        btns.forEach(b => { if (/book\s*now/i.test(b.textContent)) bookNow++; });
        if (bookNow > 0) return true;
        // Text detection
        const bodyText = document.body.innerText || '';
        const showingMatch = bodyText.match(/Showing\s*\(?(\d+)\)?\s*Hotels/i);
        if (showingMatch && parseInt(showingMatch[1], 10) > 0) return true;
        const foundMatch = bodyText.match(/(\d+)\s*hotels?\s*found/i);
        if (foundMatch && parseInt(foundMatch[1], 10) > 0) return true;
        if (/no hotels found|no results|no hotel available|showing\s*\(0\)/i.test(bodyText)) return true;
        // Price elements (₹ symbol in hotel results area)
        const prices = document.querySelectorAll('[class*="price"], [class*="rate"], [class*="amount"]');
        if (prices.length > 0) return true;
        return false;
      }, { timeout: 60000 });
    } catch { /* soft timeout */ }

    // Wait for the visible result count to STABILIZE — "Showing (N) Hotels" text stays
    // the same for 3 consecutive seconds. This measures when the loading UI actually stops
    // on screen (not background analytics/image requests which inflate network-based timing).
    // RULE: Duration = search click → result count stable for 3s + 1.5s buffer.
    const stabilityStart = Date.now();
    let lastSeenCount = null;
    let countStableSince = null;
    let textFound = false;
    while (Date.now() - stabilityStart < 45000) {
      const currentCount = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const m = text.match(/Showing\s*\(?(\d+)\)?\s*Hotels/i);
        if (m) return m[1];
        const m2 = text.match(/(\d+)\s*hotels?\s*found/i);
        if (m2) return m2[1];
        return null;
      }).catch(() => null);

      if (currentCount !== null) {
        textFound = true;
        if (currentCount === lastSeenCount) {
          if (!countStableSince) countStableSince = Date.now();
          if (Date.now() - countStableSince >= 3000) break; // 3s stable = loading done
        } else {
          lastSeenCount = currentCount;
          countStableSince = Date.now();
        }
      }
      // Early exit: if no "Showing (N) Hotels" text found after 10s, cards/prices are already visible — don't wait 45s
      if (!textFound && Date.now() - stabilityStart > 10000) break;
      await page.waitForTimeout(500);
    }

    // If no "Showing (N)" text was ever found, fall back to a short fixed wait
    if (!textFound) {
      await page.waitForTimeout(3000);
    }

    // 1.5s buffer after result count stabilizes — catches any delayed final DOM renders
    await page.waitForTimeout(1500);
    // Timer stops: search button click → result count stable for 3s + 1.5s buffer
    result.loadTimeMs = Date.now() - searchSubmitTime;
    result.searchUrl = page.url();

    // Screenshot results
    const ssStepName = `hotel-pulse-${scenario.id}`;
    result.screenshot = await screenshotter.takeStep(page, pulseId, ssStepName);
    // Construct file path for individual report (screenshotter saves to reports/journey/{pulseId}/screenshots/)
    if (result.screenshot) {
      const path = require('path');
      result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', `${ssStepName}.png`);
    }

    // Count results — prefer "Showing (N) Hotels" text, fall back to card count
    // Note: parens optional in regex to match stability check pattern (Etrav may omit them)
    const textCount = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const m1 = bodyText.match(/Showing\s*\(?(\d+)\)?\s*Hotels/i);
      if (m1) return parseInt(m1[1], 10);
      const m2 = bodyText.match(/(\d+)\s*hotels?\s*found/i);
      if (m2) return parseInt(m2[1], 10);
      return null;
    });
    const cardCount = await countHotelResults(page);
    result.resultCount = textCount != null ? textCount : cardCount;
    result.actions.push(`Results: ${result.resultCount} (text=${textCount}, cards=${cardCount})`);

    // Check for API errors
    let apiCount = 0;
    const apiDetails = [];
    const errorPatterns = ['[class*="error-message"]', '[class*="no-results"]'];
    for (const pattern of errorPatterns) {
      try {
        const el = await page.$(pattern);
        if (el) { apiCount++; const t = await el.textContent(); apiDetails.push(t?.trim()?.slice(0, 100)); }
      } catch { /* ignore */ }
    }
    result.apiErrors = apiCount;
    result.apiErrorDetail = apiDetails.join(' | ') || null;

    result.searchStatus = result.resultCount === 0 ? 'ZERO_RESULTS'
      : result.apiErrors > 0 ? 'API_ERROR'
      : 'SUCCESS';

    // Vision evaluation — ONLY for zero-result or failed searches (saves ~90% tokens)
    if (result.screenshot && (result.resultCount === 0 || result.searchStatus === 'FAILED' || result.apiErrors > 0)) {
      result.evaluation = await evaluateSearchPulse(
        result.screenshot, 'hotel_results', scenario,
        { resultCount: result.resultCount, loadTimeMs: result.loadTimeMs }
      );
    }

    logger.info(`[PULSE] Hotel ${scenario.destination}: ${result.searchStatus} | ${result.resultCount} results | ${result.loadTimeMs}ms`);
  } catch (err) {
    result.searchStatus = 'FAILED';
    result.error = err.message;
    result.failureReason = 'RUNTIME ERROR: ' + err.message;
    logger.error(`[PULSE] Hotel search failed: ${scenario.id} - ${err.message}`);
    try {
      result.screenshot = await screenshotter.takeStep(page, pulseId, `hotel-pulse-${scenario.id}`);
      if (result.screenshot) {
        const path = require('path');
        result.screenshotPath = path.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', `hotel-pulse-${scenario.id}.png`);
      }
    } catch { /* screenshot failed too */ }
  }

  return result;
}

module.exports = { runHotelSearchPulse };