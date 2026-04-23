const logger = require('../utils/logger');
const screenshotter = require('../utils/screenshotter');
const { evaluateSearchPulse } = require('./searchPulseEvaluator');
const {
  fillAutosuggest, pickHotelDateRange, clickSearchHotels, countHotelResults,
  fillHotelPax,
  dismissAllOverlays,
  isFormCrashed,
} = require('../utils/etravFormHelpers');

async function bailIfHotelCrashed(page, scenario, result, pulseId, atStep) {
  if (await isFormCrashed(page)) {
    result.searchStatus = 'ETRAV_FORM_CRASH';
    result.error = 'Etrav hotel form crashed mid-fill (after ' + atStep + ')';
    result.failureReason = 'ETRAV PLATFORM ERROR: Etrav rendered "Oops! Something went wrong" during hotel form fill (after ' + atStep + '). React error boundary fired. Aborted before triggering more downstream errors.';
    logger.error('[PULSE] Hotel ' + scenario.destination + ': mid-fill crash at ' + atStep);
    try {
      result.screenshot = await screenshotter.takeStep(page, pulseId, 'hotel-pulse-' + scenario.id);
      if (result.screenshot) {
        const pathMod = require('path');
        result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'hotel-pulse-' + scenario.id + '.png');
      }
    } catch {}
    return true;
  }
  return false;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function runHotelSearchPulse(page, scenario, pulseId) {
  // Compute check-in date upfront from scenario params (before try block so it's always set)
  const checkinDate = addDays(new Date(), scenario.checkinOffsetDays || scenario.checkinOffset || 10);
  // Same-date guard #1: hotel check-in and check-out MUST be different days.
  // Floor nights at 1 so checkout is always at least 1 day after check-in.
  const nightsRaw = scenario.nights || 3;
  const nights = Math.max(1, nightsRaw);
  const checkoutDate = addDays(checkinDate, nights);
  // Globally-unique searchId: 5-digit base + ms-timestamp suffix (base36) + 2 random chars.
  // The old format (5-digit only) collided every ~150 searches and caused report
  // mismatches — search 38841 was both a Singapore hotel AND a DEL→BLR flight.
  const searchId = String(Math.floor(10000 + Math.random() * 90000)) + '-' +
    Date.now().toString(36).slice(-5) +
    Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');

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
    nights: nights,
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

    // CRITICAL: Detect Etrav's "Oops! Something went wrong" crash page on the FORM itself.
    // When the form fails to render due to an Etrav frontend crash, fillAutosuggest()
    // would fail and we'd mislabel it as AUTOSUGGEST_DOWN. Real diagnosis: form crashed.
    const hotelFormCrashCheck = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const hasCrashText = /Oops!\s*Something went wrong|An unexpected error occurred/i.test(bodyText);
      const hasDestInput = !!document.querySelector('input[placeholder="Hotel name or Destination"], input.react-autosuggest__input');
      return { hasCrashText, hasDestInput };
    }).catch(() => ({ hasCrashText: false, hasDestInput: true }));
    if (hotelFormCrashCheck.hasCrashText && !hotelFormCrashCheck.hasDestInput) {
      result.searchStatus = 'ETRAV_FORM_CRASH';
      result.error = 'Etrav hotel form page crashed — "Oops! Something went wrong"';
      result.failureReason = 'ETRAV PLATFORM ERROR: Hotel form page rendered the crash/error illustration ("Oops! Something went wrong") instead of the search form. This is an Etrav frontend crash — agents cannot search until Etrav fixes it. Not an automation issue.';
      logger.error('[PULSE] Hotel ' + scenario.destination + ': Etrav form crash page detected');
      result.screenshot = await screenshotter.takeStep(page, pulseId, 'hotel-pulse-' + scenario.id);
      if (result.screenshot) {
        const pathMod = require('path');
        result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'hotel-pulse-' + scenario.id + '.png');
      }
      return result;
    }

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

    // CRASH CHECK after destination fill
    if (await bailIfHotelCrashed(page, scenario, result, pulseId, 'destination fill')) return result;

    // Pick check-in and check-out (checkinDate/checkoutDate already computed above before try block)
    let rangeOk = await pickHotelDateRange(page, checkinDate, checkoutDate);
    result.actions.push(`Check-in: ${checkinDate.toDateString()}, Check-out: ${checkoutDate.toDateString()} [${rangeOk ? 'OK' : 'FAIL'}]`);

    // Same-date guard #2 (RULE: hotel check-in and check-out MUST be different days):
    // Read back the two date inputs from Etrav's form and verify they show different
    // dates. Same-day check-in/check-out causes Etrav to reject the search silently —
    // witnessed in recent SPF failures where the user noticed the issue on review.
    // If same-day is detected, retry pickHotelDateRange once with nights+1. If still
    // same-day, abort with AUTOMATION_DATE_INCOMPLETE rather than submitting.
    try {
      const readBack = async () => await page.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        const dates = { checkin: '', checkout: '' };
        for (const inp of inputs) {
          const ph = (inp.placeholder || '').toLowerCase();
          const val = (inp.value || '').trim();
          if (ph.includes('check') && ph.includes('in'))  dates.checkin  = val;
          if (ph.includes('check') && ph.includes('out')) dates.checkout = val;
        }
        if (!dates.checkin || !dates.checkout) {
          // Fallback: date displays render as div text like "22 Apr'26"
          document.querySelectorAll('div').forEach(d => {
            if (d.children.length > 0) return;
            const t = (d.textContent || '').trim();
            if (/^\d{1,2}\s+\w{3}['\u2019]\d{2}$/.test(t)) {
              if (!dates.checkin)       dates.checkin  = t;
              else if (!dates.checkout) dates.checkout = t;
            }
          });
        }
        return dates;
      }).catch(() => ({ checkin: '', checkout: '' }));

      let d1 = await readBack();
      if (d1.checkin && d1.checkout && d1.checkin === d1.checkout) {
        logger.warn('[PULSE] Hotel same-date detected (' + d1.checkin + ' == ' + d1.checkout + ') — retrying with nights+1');
        result.actions.push('Same-date check-out detected (' + d1.checkin + ') — retrying with extra night');
        const retryCheckout = addDays(checkinDate, nights + 1);
        rangeOk = await pickHotelDateRange(page, checkinDate, retryCheckout);
        const d2 = await readBack();
        if (d2.checkin && d2.checkout && d2.checkin === d2.checkout) {
          result.searchStatus = 'AUTOMATION_DATE_INCOMPLETE';
          result.error = 'Hotel check-in and check-out resolved to the same date';
          result.failureReason = 'AUTOMATION ISSUE: Hotel form ended up with identical check-in and check-out dates (' + d2.checkin + '). Retry with nights+1 also failed. Aborted BEFORE submit — Etrav silently rejects same-day stays and reports SPF. NOT an Etrav issue. Destination: ' + scenario.destination + ', planned nights: ' + nights + '.';
          logger.error('[PULSE] ' + result.error);
          result.screenshot = await screenshotter.takeStep(page, pulseId, 'hotel-pulse-' + scenario.id);
          if (result.screenshot) {
            const pathMod = require('path');
            result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'hotel-pulse-' + scenario.id + '.png');
          }
          return result;
        }
        logger.info('[PULSE] Hotel same-date recovered — now ' + d2.checkin + ' -> ' + d2.checkout);
        result.actions.push('Same-date recovery OK: ' + d2.checkin + ' -> ' + d2.checkout);
      }
    } catch (verifyErr) {
      logger.warn('[PULSE] Hotel same-date readback threw (continuing): ' + verifyErr.message);
    }

    // Dismiss all overlays after date selection
    await dismissAllOverlays(page);

    // CRASH CHECK after date pick
    if (await bailIfHotelCrashed(page, scenario, result, pulseId, 'date pick')) return result;

    // Set rooms and pax
    if (scenario.roomPax && scenario.roomPax.length > 0) {
      const paxOk = await fillHotelPax(page, scenario.rooms || 1, scenario.roomPax);
      const paxLabel = scenario.roomPax.map((r, i) => `R${i + 1}:${r.adults}A${r.children > 0 ? ' ' + r.children + 'C' : ''}`).join(' ');
      result.actions.push(`Rooms & Guests: ${scenario.rooms || 1}R — ${paxLabel} [${paxOk ? 'OK' : 'FAIL'}]`);
    }

    // CRASH CHECK after pax fill
    if (await bailIfHotelCrashed(page, scenario, result, pulseId, 'pax fill')) return result;

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
    // PRE-SUBMIT VALIDATION: read hotel form state before clicking Search
    const preSubmitH = await page.evaluate(() => {
      const destInput = document.querySelector('input[placeholder="Hotel name or Destination"], input.react-autosuggest__input');
      // Date fields show their value as text (or "-" when empty)
      const inputs = document.querySelectorAll('input');
      const dates = { checkin: '', checkout: '' };
      inputs.forEach(inp => {
        const ph = (inp.placeholder || '').toLowerCase();
        if (ph.includes('check') && ph.includes('in')) dates.checkin = (inp.value || '').trim();
        if (ph.includes('check') && ph.includes('out')) dates.checkout = (inp.value || '').trim();
      });
      // Fallback: read from displayed date text
      if (!dates.checkin || !dates.checkout) {
        document.querySelectorAll('div').forEach(d => {
          if (d.children.length > 0) return;
          const t = (d.textContent || '').trim();
          if (/^\d{1,2}\s+\w{3}'\d{2}$/.test(t)) {
            if (!dates.checkin) dates.checkin = t;
            else if (!dates.checkout) dates.checkout = t;
          }
        });
      }
      return {
        dest: destInput ? destInput.value : '',
        checkin: dates.checkin,
        checkout: dates.checkout
      };
    }).catch(() => ({}));
    const issuesH = [];
    if (!preSubmitH.dest) issuesH.push('destination empty');
    if (!preSubmitH.checkin || preSubmitH.checkin === '-') issuesH.push('check-in empty');
    if (!preSubmitH.checkout || preSubmitH.checkout === '-') issuesH.push('check-out empty');
    if (issuesH.length > 0) {
      result.actions.push('PRE-SUBMIT WARNINGS: ' + issuesH.join(', ') + ' (form: ' + JSON.stringify(preSubmitH) + ')');
      logger.warn('[PULSE] Hotel pre-submit warnings for ' + scenario.destination + ': ' + issuesH.join(', '));
      // AUTO-REPAIR: if checkout is empty for hotel, attempt to set it
      if (issuesH.includes('check-out empty') && !issuesH.includes('check-in empty')) {
        try {
          const checkoutDate = new Date(checkinDate);
          checkoutDate.setDate(checkoutDate.getDate() + (scenario.nights || 1));
          await pickHotelDateRange(page, checkinDate, checkoutDate);
          result.actions.push('AUTO-REPAIR: re-attempted hotel date range');
        } catch (repairErr) {
          logger.warn('[PULSE] Auto-repair of hotel dates failed: ' + repairErr.message);
        }
      }
      // AUTO-RECOVERY: if destination got cleared by a miss-click during pax/date fill,
      // refill it. Submitting an empty destination causes Etrav to crash and produces a
      // misleading AUTOSUGGEST_DOWN diagnosis.
      if (issuesH.includes('destination empty')) {
        logger.warn('[PULSE] AUTO-RECOVERY: refilling cleared hotel destination');
        const ok = await fillAutosuggest(page, 'Hotel name or Destination', scenario.destination);
        result.actions.push('AUTO-RECOVERY destination refill: ' + (ok ? 'OK' : 'FAIL'));
        const recheckDest = await page.evaluate(() => {
          const i = document.querySelector('input[placeholder="Hotel name or Destination"], input.react-autosuggest__input');
          return i ? i.value : '';
        }).catch(() => '');
        if (!recheckDest) {
          result.searchStatus = 'AUTOMATION_FORM_RESET';
          result.error = 'Hotel destination cleared mid-fill and could not be refilled';
          result.failureReason = 'AUTOMATION ISSUE: After destination was filled successfully, a subsequent click during date or pax fill cleared the field. Auto-recovery refill also failed. Aborted to avoid triggering Etrav crash page from empty submission.';
          logger.error('[PULSE] ' + result.error);
          result.screenshot = await screenshotter.takeStep(page, pulseId, 'hotel-pulse-' + scenario.id);
          if (result.screenshot) {
            const pathMod = require('path');
            result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'hotel-pulse-' + scenario.id + '.png');
          }
          return result;
        }
        result.actions.push('AUTO-RECOVERY succeeded — destination refilled (' + recheckDest + ')');
      }
    }

    // Click search (uses multi-strategy click in clickSearchHotels)
    let searchClicked = await clickSearchHotels(page);

    // POST-CLICK AUTO-RETRY: if URL doesn't change in 5s, retry once
    if (searchClicked) {
      const urlChangedH = await page.waitForFunction(
        () => /hotels\/search-results/i.test(window.location.href),
        { timeout: 5000 }
      ).then(() => true).catch(() => false);
      if (!urlChangedH) {
        logger.warn('[PULSE] First hotel search click did not navigate — retrying after dismiss');
        await dismissAllOverlays(page);
        await page.waitForTimeout(500);
        searchClicked = await clickSearchHotels(page);
        result.actions.push('Hotel search retried after URL no-change');
      }
    }
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
        const showingMatch = bodyText.match(/Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Hotels/i);
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
    //
    // CRITICAL: Etrav renders the right-side hotel cards FIRST, then the left-side filter
    // panel (which contains "Showing N Hotels") renders 5-15s LATER. So we MUST wait for
    // the left sidebar skeleton to disappear before reading the count, otherwise we fall
    // back to cardCount=30 (Etrav's default page size) and report 30 for every search.
    const stabilityStart = Date.now();
    let lastSeenCount = null;
    let countStableSince = null;
    let textFound = false;
    let leftPanelLoaded = false;
    while (Date.now() - stabilityStart < 60000) {
      const probe = await page.evaluate(() => {
        const text = document.body.innerText || '';
        // Multi-pattern extraction (same logic as final result count)
        const patterns = [
          /Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Hotels?/i,
          /Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Propert/i,
          /Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Stays?/i,
          /(\d+)\s*hotels?\s*found/i,
          /(\d+)\s*properties?\s*found/i,
          /Showing\s*[\(\[](\d+)[\)\]]/i
        ];
        let count = null;
        for (const re of patterns) {
          const m = text.match(re);
          if (m) { count = m[1]; break; }
        }
        // Detect left filter sidebar loaded (skeleton boxes gone, real filter labels present)
        // Etrav left sidebar shows price/rating/amenity filter headers once loaded.
        const filterTextLoaded = /price\s*range|star\s*rating|amenities|hotel\s*type|guest\s*rating/i.test(text);
        // Skeleton boxes have specific class names on Etrav
        const skeletonCount = document.querySelectorAll(
          '[class*="skeleton"], [class*="Skeleton"], [class*="shimmer"], [class*="Shimmer"], [class*="loader"]:not([class*="loaded"])'
        ).length;
        return { count, filterTextLoaded, skeletonCount };
      }).catch(() => ({ count: null, filterTextLoaded: false, skeletonCount: 99 }));

      if (probe.filterTextLoaded || probe.skeletonCount === 0) leftPanelLoaded = true;

      if (probe.count !== null) {
        textFound = true;
        if (probe.count === lastSeenCount) {
          if (!countStableSince) countStableSince = Date.now();
          if (Date.now() - countStableSince >= 3000) break; // 3s stable = loading done
        } else {
          lastSeenCount = probe.count;
          countStableSince = Date.now();
        }
      }
      // Only early-exit if BOTH text not found AND left panel is loaded (no more skeletons)
      // This means count text genuinely doesn't exist for this page — don't wait further.
      if (!textFound && leftPanelLoaded && Date.now() - stabilityStart > 20000) break;
      // Hard fallback: if 30s passed and still no text, wait one more cycle then break
      if (!textFound && Date.now() - stabilityStart > 30000) break;
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

    // Count results — multi-pattern extraction to handle Etrav's varying phrasing
    // (sometimes "Showing N Hotels", sometimes "Showing N properties", sometimes "Showing (N)" etc.)
    const textCount = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const candidates = [];

      // Pattern 0 (HIGHEST priority): pagination format "Showing N - M of TOTAL Hotels"
      // Etrav often uses this for cities with many results — must extract TOTAL, not N or M.
      const mPaginated = bodyText.match(/Showing\s*\d+\s*[-–to]+\s*\d+\s*of\s*(\d+)\s*Hotels?/i);
      if (mPaginated) candidates.push({ n: parseInt(mPaginated[1], 10), priority: 0 });
      // Also handle "of N Properties" variant
      const mPaginatedProp = bodyText.match(/Showing\s*\d+\s*[-–to]+\s*\d+\s*of\s*(\d+)\s*Propert/i);
      if (mPaginatedProp) candidates.push({ n: parseInt(mPaginatedProp[1], 10), priority: 0 });

      // Pattern 1: "Showing [N] Hotels" or "Showing (N) Hotels" or "Showing N Hotels"
      // Etrav actually uses [N] (square brackets) for hotel counts — handle both bracket types
      const m1 = bodyText.match(/Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Hotels?/i);
      if (m1) candidates.push({ n: parseInt(m1[1], 10), priority: 1 });

      // Pattern 2: "Showing [N] Properties" — same bracket fix as Pattern 1
      const m2 = bodyText.match(/Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Propert/i);
      if (m2) candidates.push({ n: parseInt(m2[1], 10), priority: 1 });

      // Pattern 3: "Showing [N] Stays" — same bracket fix
      const m3 = bodyText.match(/Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Stays?/i);
      if (m3) candidates.push({ n: parseInt(m3[1], 10), priority: 1 });

      // Pattern 4: "N hotels/properties found" reverse phrasing
      const m4 = bodyText.match(/(\d+)\s*hotels?\s*found/i);
      if (m4) candidates.push({ n: parseInt(m4[1], 10), priority: 2 });
      const m5 = bodyText.match(/(\d+)\s*properties?\s*found/i);
      if (m5) candidates.push({ n: parseInt(m5[1], 10), priority: 2 });

      // Pattern 6: "Showing [N]" or "Showing (N)" alone — handle both brackets
      const m6 = bodyText.match(/Showing\s*[\(\[](\d+)[\)\]]/i);
      if (m6) candidates.push({ n: parseInt(m6[1], 10), priority: 3 });

      // Pattern 7 (DOM-based fallback): Read from Etrav's specific result counter element
      // Etrav usually puts the count in a span/div near the top of results
      try {
        const els = document.querySelectorAll('[class*="showing" i], [class*="result-count" i], [class*="ResultCount" i], [class*="totalResult" i]');
        for (const el of els) {
          const t = (el.textContent || '').trim();
          const m = t.match(/(\d+)/);
          if (m) candidates.push({ n: parseInt(m[1], 10), priority: 2 });
        }
      } catch {}

      if (candidates.length === 0) return null;
      // Pick the highest-priority match (lower priority number = better)
      // If multiple at same priority, pick the largest plausible count
      candidates.sort((a, b) => a.priority - b.priority || b.n - a.n);
      return candidates[0].n;
    });
    const cardCount = await countHotelResults(page);
    // CRITICAL: cardCount=30 is Etrav's default initial page size — it is NOT the true total.
    // Only use cardCount as fallback if textCount is unavailable AND cardCount is NOT 30
    // (or explicit small numbers indicating a real partial set, like 1-29).
    // If textCount missing AND cardCount=30, do one more aggressive read attempt before settling.
    if (textCount == null && cardCount === 30) {
      // Final attempt: scroll page + wait + re-read text. Some Etrav pages render the
      // "Showing N Hotels" sidebar lazily, only after user scrolls.
      try {
        await page.evaluate(() => window.scrollBy(0, 400));
        await page.waitForTimeout(2500);
        const retryText = await page.evaluate(() => {
          const text = document.body.innerText || '';
          const patterns = [
            /Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Hotels?/i,
            /Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Propert/i,
            /(\d+)\s*hotels?\s*found/i,
            /(\d+)\s*properties?\s*found/i,
          ];
          for (const re of patterns) {
            const m = text.match(re);
            if (m) return parseInt(m[1], 10);
          }
          return null;
        });
        if (retryText != null) {
          result.resultCount = retryText;
          result.actions.push(`Results: ${result.resultCount} (text=null, cards=30, retry-after-scroll=${retryText})`);
        } else {
          // No text found even after retry — record as cards-only with warning flag
          result.resultCount = cardCount;
          result.countSource = 'card-count-fallback';
          result.actions.push(`Results: ${result.resultCount} (FALLBACK: text=null after scroll-retry, using cardCount=${cardCount}, may be page-size not true total)`);
        }
      } catch {
        result.resultCount = cardCount;
        result.actions.push(`Results: ${result.resultCount} (text=null, cards=${cardCount})`);
      }
    } else {
      result.resultCount = textCount != null ? textCount : cardCount;
      result.actions.push(`Results: ${result.resultCount} (text=${textCount}, cards=${cardCount})`);
    }

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