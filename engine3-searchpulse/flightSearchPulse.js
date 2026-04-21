const logger = require('../utils/logger');
const screenshotter = require('../utils/screenshotter');
const { evaluateSearchPulse } = require('./searchPulseEvaluator');
const {
  fillAutosuggest, pickReactDate, pickFlightDateRange, selectTripType,
  clickSearchFlight, countFlightResults, getFlightResultCountFromText,
  fillFlightPax,
  toggleRoundTripFare,
  dismissAllOverlays,
  isFormCrashed,
  FLIGHT_RESULT_SELECTOR,
} = require('../utils/etravFormHelpers');

// Helper: detect Etrav crash mid-fill and bail with a clean status (so we don't
// waste time clicking on a crashed form, then mislabel it as AUTOSUGGEST_DOWN).
async function bailIfCrashed(page, scenario, result, pulseId, atStep) {
  if (await isFormCrashed(page)) {
    result.searchStatus = 'ETRAV_FORM_CRASH';
    result.error = 'Etrav form crashed mid-fill (after ' + atStep + ')';
    result.failureReason = 'ETRAV PLATFORM ERROR: Etrav rendered "Oops! Something went wrong" during form fill (after ' + atStep + '). React error boundary fired. Aborted before triggering more downstream errors.';
    logger.error('[PULSE] Flight ' + scenario.from + '->' + scenario.to + ': mid-fill crash at ' + atStep);
    try {
      result.screenshot = await screenshotter.takeStep(page, pulseId, 'flight-pulse-' + scenario.id);
      if (result.screenshot) {
        const pathMod = require('path');
        result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'flight-pulse-' + scenario.id + '.png');
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

async function runFlightSearchPulse(page, scenario, pulseId) {
  // Compute search date upfront from scenario params (before try block so it's always set)
  const depDate = addDays(new Date(), scenario.dateOffsetDays || scenario.dateOffset || 7);
  // Globally-unique searchId: 5-digit base + ms-timestamp suffix (base36) + 2 random chars.
  // The old format (5-digit only) collided every ~150 searches and caused report
  // mismatches — search 38841 flight DEL→BLR was confused with same-id Singapore hotel
  // from days earlier because history.find() returned the FIRST entry with that searchId.
  const searchId = String(Math.floor(10000 + Math.random() * 90000)) + '-' +
    Date.now().toString(36).slice(-5) +
    Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');

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

    // CRITICAL: Detect Etrav's "Oops! Something went wrong" crash page on the FORM itself.
    // When Etrav's frontend crashes during navigation, the form never renders — the page
    // shows only the error illustration + "Try Again" / "Back to Home" buttons. Without
    // this check, we proceed to fillAutosuggest() which fails (no inputs exist), then
    // mislabel the failure as AUTOSUGGEST_DOWN. Real diagnosis: Etrav form page crashed.
    const formCrashCheck = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const hasCrashText = /Oops!\s*Something went wrong|An unexpected error occurred/i.test(bodyText);
      const hasOriginInput = !!document.querySelector('input[placeholder="Where From ?"]');
      const hasDestInput = !!document.querySelector('input[placeholder="Where To ?"]');
      return { hasCrashText, hasOriginInput, hasDestInput };
    }).catch(() => ({ hasCrashText: false, hasOriginInput: true, hasDestInput: true }));
    if (formCrashCheck.hasCrashText && (!formCrashCheck.hasOriginInput || !formCrashCheck.hasDestInput)) {
      result.searchStatus = 'ETRAV_FORM_CRASH';
      result.error = 'Etrav form page crashed — "Oops! Something went wrong"';
      result.failureReason = 'ETRAV PLATFORM ERROR: Flight form page rendered the crash/error illustration ("Oops! Something went wrong") instead of the search form. This is an Etrav frontend crash — agents cannot search until Etrav fixes it. Not an automation issue.';
      logger.error('[PULSE] Flight ' + scenario.from + '->' + scenario.to + ': Etrav form crash page detected');
      result.screenshot = await screenshotter.takeStep(page, pulseId, 'flight-pulse-' + scenario.id);
      if (result.screenshot) {
        const pathMod = require('path');
        result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'flight-pulse-' + scenario.id + '.png');
      }
      return result;
    }

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

    // CRASH CHECK after origin/destination fill — if Etrav crashed during the
    // autosuggest interaction (witnessed in 21881), bail out with proper status
    // instead of continuing to date pick which would fail downstream.
    if (await bailIfCrashed(page, scenario, result, pulseId, 'origin/destination fill')) return result;

    // Date selection: round-trip uses RANGE picker (single open calendar for both dates).
    // Etrav's roundtrip calendar shows 2 months and stays open after departure click,
    // expecting the return click in the SAME calendar — close+reopen breaks it.
    const isRoundTrip = (scenario.tripType === 'round-trip' || scenario.tripType === 'open-jaw') && (scenario.returnOffset || scenario.returnOffsetDays);

    if (isRoundTrip) {
      const retDays = (scenario.dateOffsetDays || scenario.dateOffset || 7) + (scenario.returnOffset || scenario.returnOffsetDays || 7);
      const retDate = addDays(new Date(), retDays);

      // ROUND-TRIP ORDER GATE (user feedback): return date MUST commit BEFORE
      // any other form action (pax, cabin, etc.). pickFlightDateRange already
      // has its own 3-attempt retry + verification loop internally — we trust
      // that and don't wrap it in an outer retry (which previously caused
      // calendar state conflicts where outer attempt #2+ couldn't even find
      // the return day element because the calendar was half-open).
      //
      // If pickFlightDateRange's internal retries all fail, abort IMMEDIATELY
      // BEFORE pax fill — no empty-form submit, no Etrav crash.
      const rangeOk = await pickFlightDateRange(page, depDate, retDate);
      result.actions.push('Departure: ' + depDate.toDateString() + ' | Return: ' + retDate.toDateString() + ' [' + (rangeOk ? 'OK' : 'FAIL') + ']');
      await dismissAllOverlays(page);

      if (!rangeOk) {
        result.searchStatus = 'AUTOMATION_DATE_INCOMPLETE';
        result.error = 'Return date could not be set on round-trip form';
        result.failureReason = 'AUTOMATION ISSUE: pickFlightDateRange failed all 3 internal retries for return date commit. Aborted BEFORE pax fill so we never submit an incomplete form and trigger an Etrav "Return date is required" error. NOT an Etrav issue. Sector: ' + (scenario.from || '') + '\u2192' + (scenario.to || '') + ', dep=' + depDate.toDateString() + ', ret=' + retDate.toDateString() + '.';
        logger.error('[PULSE] ' + result.error);
        result.screenshot = await screenshotter.takeStep(page, pulseId, 'flight-pulse-' + scenario.id);
        if (result.screenshot) {
          const pathMod = require('path');
          result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'flight-pulse-' + scenario.id + '.png');
        }
        return result;
      }
    } else {
      // One-way: separate departure picker only
      const depOk = await pickReactDate(page, 0, depDate);
      result.actions.push(`Departure: ${depDate.toDateString()} [${depOk ? 'OK' : 'FAIL'}]`);
      await dismissAllOverlays(page);
    }

    // CRASH CHECK after date pick — date pickers are another fragile transition
    // where Etrav's React can throw if our click landed at a bad moment.
    if (await bailIfCrashed(page, scenario, result, pulseId, 'date pick')) return result;

    // Dismiss all overlays before pax/cabin fill to ensure nothing blocks the traveller dropdown
    await dismissAllOverlays(page);

    // Set passenger count (adults, children, infants)
    if (scenario.passengers) {
      const paxOk = await fillFlightPax(page, scenario.passengers, scenario.cabinClass);
      result.actions.push(`Passengers: ${scenario.passengers.adults}A ${scenario.passengers.children}C ${scenario.passengers.infants}I | Cabin: ${scenario.cabinClass} [${paxOk ? 'OK' : 'FAIL'}]`);
    }

    // CRASH CHECK after pax fill (third fragile transition).
    if (await bailIfCrashed(page, scenario, result, pulseId, 'pax fill')) return result;

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

    // PRE-SUBMIT VALIDATION: read form state before clicking Search.
    // If anything is missing, log it (we still try to submit; partial form is better than none).
    const preSubmit = await page.evaluate(() => {
      const fromInput = document.querySelector('input[placeholder="Where From ?"]');
      const toInput = document.querySelector('input[placeholder="Where To ?"]');
      const wrappers = document.querySelectorAll('.react-datepicker-wrapper');
      const depDateText = wrappers[0] ? (wrappers[0].textContent || '').trim() : '';
      const retDateText = wrappers[1] ? (wrappers[1].textContent || '').trim() : '';
      return {
        from: fromInput ? fromInput.value : '',
        to: toInput ? toInput.value : '',
        depDate: depDateText,
        retDate: retDateText
      };
    }).catch(() => ({}));
    const issues = [];
    if (!preSubmit.from) issues.push('origin empty');
    if (!preSubmit.to) issues.push('destination empty');
    if (!preSubmit.depDate || preSubmit.depDate === '-') issues.push('departure empty');
    if (scenario.tripType === 'round-trip' && !/\d{1,2}\s+\w{3}\s*[''`]\s*\d{2}/.test(preSubmit.retDate || '')) issues.push('return empty');
    if (issues.length > 0) {
      result.actions.push('PRE-SUBMIT WARNINGS: ' + issues.join(', ') + ' (form: ' + JSON.stringify(preSubmit) + ')');
      logger.warn('[PULSE] Pre-submit warnings for ' + scenario.from + '->' + scenario.to + ': ' + issues.join(', '));

      // AUTO-RECOVERY: a miss-click during date/pax fill may have cleared the autosuggest
      // fields. Refill them rather than submitting an empty form (which causes Etrav to
      // crash and gets misdiagnosed downstream). One refill attempt only — if still empty,
      // abort with proper status so we don't trigger an Etrav crash page.
      if (!preSubmit.from || !preSubmit.to) {
        logger.warn('[PULSE] AUTO-RECOVERY: refilling cleared autosuggest fields');
        if (!preSubmit.from) {
          const ok = await fillAutosuggest(page, 'Where From ?', scenario.fromCity || scenario.from);
          result.actions.push('AUTO-RECOVERY origin refill: ' + (ok ? 'OK' : 'FAIL'));
        }
        if (!preSubmit.to) {
          const ok = await fillAutosuggest(page, 'Where To ?', scenario.toCity || scenario.to);
          result.actions.push('AUTO-RECOVERY destination refill: ' + (ok ? 'OK' : 'FAIL'));
        }
        // Re-validate after refill
        const recheck = await page.evaluate(() => ({
          from: (document.querySelector('input[placeholder="Where From ?"]') || {}).value || '',
          to: (document.querySelector('input[placeholder="Where To ?"]') || {}).value || ''
        })).catch(() => ({ from: '', to: '' }));
        if (!recheck.from || !recheck.to) {
          // Abort — submitting now would crash Etrav and produce a misleading error.
          result.searchStatus = 'AUTOMATION_FORM_RESET';
          result.error = 'Form fields cleared mid-fill and could not be refilled (' + (!recheck.from ? 'origin ' : '') + (!recheck.to ? 'destination' : '') + ')';
          result.failureReason = 'AUTOMATION ISSUE: After origin/destination were filled successfully, a subsequent click during date or pax fill cleared the field(s). Auto-recovery refill also failed. Aborted to avoid triggering Etrav crash page from empty submission.';
          logger.error('[PULSE] ' + result.error);
          result.screenshot = await screenshotter.takeStep(page, pulseId, 'flight-pulse-' + scenario.id);
          if (result.screenshot) {
            const pathMod = require('path');
            result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'flight-pulse-' + scenario.id + '.png');
          }
          return result;
        }
        result.actions.push('AUTO-RECOVERY succeeded — fields refilled (from=' + recheck.from + ', to=' + recheck.to + ')');
      }

      // AUTO-RECOVERY for missing return date (round-trip only) — search 14671 fix.
      // If return date is empty on a round-trip search, retry the date range pick
      // rather than submitting and getting Etrav's "Return date is required" error.
      //
      // INTL-ONLY enhancement (search 61401 DEL→KWI Business): for international
      // round-trip searches we retry UP TO 3 times with increasing waits between
      // attempts. INTL calendar interactions are flakier because the larger pax
      // counts + cabin class selection cause extra re-renders that can interfere
      // with the range picker commit. DOM round-trip retries once (as before).
      if (scenario.tripType === 'round-trip' && !/\d{1,2}\s+\w{3}\s*[''`]\s*\d{2}/.test(preSubmit.retDate || '')) {
        const retryCount = scenario.type === 'international' ? 3 : 1;
        logger.warn('[PULSE] AUTO-RECOVERY: return date missing for round-trip — retrying date range (' + retryCount + ' attempts for ' + scenario.type + ')');
        try {
          const retDays = (scenario.dateOffsetDays || scenario.dateOffset || 7) + (scenario.returnOffset || scenario.returnOffsetDays || 7);
          const retDateRetry = addDays(new Date(), retDays);
          let retCheck = '';
          for (let attempt = 1; attempt <= retryCount; attempt++) {
            const rangeRetryOk = await pickFlightDateRange(page, depDate, retDateRetry);
            result.actions.push('AUTO-RECOVERY date range retry #' + attempt + ': ' + (rangeRetryOk ? 'OK' : 'FAIL'));
            if (attempt < retryCount) await page.waitForTimeout(1200 * attempt);
            retCheck = await page.evaluate(() => {
              const wrappers = document.querySelectorAll('.react-datepicker-wrapper');
              return wrappers[1] ? (wrappers[1].textContent || '').trim() : '';
            }).catch(() => '');
            if (retCheck && retCheck !== '-') break; // committed — stop retrying
          }
          if (!retCheck || retCheck === '-') {
            result.searchStatus = 'AUTOMATION_DATE_INCOMPLETE';
            result.error = 'Return date could not be set on round-trip form';
            result.failureReason = 'AUTOMATION ISSUE: Return date failed to commit even after retry. pickFlightDateRange clicked the date element but Etrav rejected the selection (possibly range order issue or silent re-render). Aborted before submit to avoid "Return date is required" error from Etrav. This is NOT an Etrav issue.';
            logger.error('[PULSE] ' + result.error);
            result.screenshot = await screenshotter.takeStep(page, pulseId, 'flight-pulse-' + scenario.id);
            if (result.screenshot) {
              const pathMod = require('path');
              result.screenshotPath = pathMod.join(__dirname, '..', 'reports', 'journey', pulseId, 'screenshots', 'flight-pulse-' + scenario.id + '.png');
            }
            return result;
          }
          result.actions.push('AUTO-RECOVERY return date set: ' + retCheck);
        } catch (dateRetryErr) {
          logger.warn('[PULSE] Return date retry threw: ' + dateRetryErr.message);
        }
      }
    }

    // Click search (uses multi-strategy click in clickSearchFlight)
    let searchClicked = await clickSearchFlight(page);

    // POST-CLICK AUTO-RETRY: if URL doesn't change in 5s, the click probably hit an
    // overlay or didn't register. Try once more with a fresh dismissAllOverlays.
    if (searchClicked) {
      const urlChanged = await page.waitForFunction(
        () => /flights\/(oneway|roundtrip)/i.test(window.location.href),
        { timeout: 5000 }
      ).then(() => true).catch(() => false);
      if (!urlChanged) {
        logger.warn('[PULSE] First search click did not navigate — retrying after dismiss');
        await dismissAllOverlays(page);
        await page.waitForTimeout(500);
        searchClicked = await clickSearchFlight(page);
        result.actions.push('Search retried after URL no-change');
      }
    }
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
        // FAILURE ATTRIBUTION (search 14671 fix): before blaming autosuggest,
        // READ Etrav's visible validation errors and the actual form state.
        // Etrav shows red inline errors like "Return date is required" next to
        // the failing field. If we see any, we KNOW the fault is on EQIS side
        // (we didn't fill a required field properly) — not autosuggest.
        const diag = await page.evaluate(() => {
          const body = document.body.innerText || '';
          // Detect common Etrav validation errors
          const errors = [];
          if (/return\s*date\s*is\s*required/i.test(body)) errors.push('return-date-missing');
          if (/departure\s*date\s*is\s*required/i.test(body)) errors.push('departure-date-missing');
          if (/origin\s*is\s*required|from\s*is\s*required/i.test(body)) errors.push('origin-missing');
          if (/destination\s*is\s*required|to\s*is\s*required/i.test(body)) errors.push('destination-missing');
          if (/at\s*least\s*1\s*adult|passenger\s*is\s*required/i.test(body)) errors.push('pax-missing');
          // Read current form values
          const fromI = document.querySelector('input[placeholder="Where From ?"]');
          const toI = document.querySelector('input[placeholder="Where To ?"]');
          const wrappers = document.querySelectorAll('.react-datepicker-wrapper');
          return {
            errors,
            from: fromI ? fromI.value : '',
            to: toI ? toI.value : '',
            depDate: wrappers[0] ? (wrappers[0].textContent || '').trim() : '',
            retDate: wrappers[1] ? (wrappers[1].textContent || '').trim() : '',
          };
        }).catch(() => ({ errors: [], from: '', to: '', depDate: '', retDate: '' }));

        result.searchStatus = 'FAILED';
        result.error = 'Search did not submit — URL stayed on form page';

        // Classify based on ACTUAL form state, not generic guesses
        if (diag.errors.length > 0) {
          // Etrav's validation blocked us → EQIS-side (we didn't fill required fields)
          const missing = diag.errors.join(', ');
          result.searchStatus = 'AUTOMATION_FIELD_INCOMPLETE';
          result.failureReason = 'AUTOMATION ISSUE: EQIS did not fully populate the form before submit. Etrav\'s inline validation shows: [' + missing + ']. Form state at submit: from="' + diag.from + '", to="' + diag.to + '", depDate="' + diag.depDate + '", retDate="' + diag.retDate + '". This is NOT an Etrav issue — our form-fill logic needs to verify each field committed before clicking Search.';
        } else if (!diag.from || !diag.to) {
          result.searchStatus = 'AUTOMATION_FORM_RESET';
          result.failureReason = 'AUTOMATION ISSUE: Origin/destination field was cleared before submit (from="' + diag.from + '", to="' + diag.to + '"). Our clicks during date/pax fill likely caused React to reset the autosuggest value. Not an Etrav issue.';
        } else {
          result.failureReason = 'UNCERTAIN: Form showed from="' + diag.from + '", to="' + diag.to + '", depDate="' + diag.depDate + '", retDate="' + diag.retDate + '" but search did not navigate. Could be our click not registering, Etrav submit handler failing, or a silent validation error not matched by known patterns.';
        }

        logger.error(`[PULSE] Flight ${scenario.from}->${scenario.to}: ${result.searchStatus} — ${result.failureReason}`);
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
    // INTL-ONLY FIX (applies only when scenario.type === 'international'):
    // Etrav's progress bar sometimes stays visible after INTL results load because
    // INTL responses aggregate multiple GDS sources with stragglers. Audit of 3 of
    // last 5 INTL failures (84141 DEL→DXB, 53321 AUH→DEL, 21835 JED→BOM) showed
    // flights were FULLY LOADED with prices + "Showing (N) Flights" text, but we
    // reported FAILED because bar didn't disappear. We now declare success when
    // real result evidence is visible, regardless of the bar's state. DOM searches
    // are unaffected — DOM continues to wait strictly on the bar.
    const isIntl = scenario.type === 'international';
    try {
      await page.waitForFunction((isIntlFlag) => {
        const bar = document.querySelector('.progress-bar-container');
        const barGone = !bar || bar.offsetParent === null;
        if (barGone) return true;
        // INTL-only escape hatch: if real result evidence is present, treat as done
        if (!isIntlFlag) return false;
        const cards = document.querySelectorAll('.accordion_container').length;
        const bodyText = document.body.innerText || '';
        const showingMatch = bodyText.match(/Showing\s*[\(\[]?\s*(\d+)\s*[\)\]]?\s*Flights?/i);
        const hasResults = (cards >= 3 && showingMatch && parseInt(showingMatch[1], 10) > 0);
        return hasResults;
      }, { timeout: 60000 }, isIntl);
      loaderGone = true;
      // Check which branch completed
      const stillBarVisible = await page.evaluate(() => {
        const bar = document.querySelector('.progress-bar-container');
        return !!(bar && bar.offsetParent !== null);
      });
      if (stillBarVisible && isIntl) {
        result.actions.push('INTL: declared SUCCESS via result-evidence escape hatch (bar still visible but results loaded)');
      } else {
        result.actions.push('Loading bar disappeared');
      }
    } catch {
      // Even the escape hatch didn't see results within 60s — genuine Etrav timeout
      result.searchStatus = 'FAILED';
      result.error = 'Loading bar still visible after 60s — search hung';
      result.failureReason = 'ETRAV ISSUE: Loading progress bar did not disappear within 60 seconds AND no result evidence detected. Etrav API likely timed out or hung mid-search.';
      result.loadTimeMs = Date.now() - searchSubmitTime;
      result.searchUrl = page.url();
      logger.error('[PULSE] Flight ' + scenario.from + '->' + scenario.to + ': loading bar stuck > 60s (no results detected either)');
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