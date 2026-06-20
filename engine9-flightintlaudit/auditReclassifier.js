// auditReclassifier.js — Engine 9: AUTOSUGGEST_DOWN reclassifier (ADDITIVE, Engine-9 only).
//
// PROBLEM (root-caused 2026-06-20 via a FRAKA video-vs-data audit of run
// FIA-MQLBT6Q7-7FF0): engine3-searchpulse/flightSearchPulse.js collapses TWO
// distinct failure modes into a single AUTOSUGGEST_DOWN status —
//   (a) the flight search FORM NEVER RENDERED / the /flights page did not load
//       (an EQIS-side page-load problem — the engine gave up before Etrav's
//        autosuggest was ever exercised; the run ended sitting on the post-login
//        dashboard with no "Where From ?"/"Where To ?" inputs on the page), and
//   (b) the form WAS present but Etrav's autosuggest returned no suggestions
//       (a genuine Etrav-side product failure).
// Both make fillAutosuggest() return false, so both are labelled AUTOSUGGEST_DOWN
// at flightSearchPulse.js:313-316 and (wrongly, for case a) blamed on Etrav.
//
// THIS MODULE re-labels case (a) → FLIGHT_FORM_NOT_LOADED using LIVE-PAGE evidence:
// the search-form inputs are probed on the STILL-OPEN page right after PHASE A
// (the FRAKA verifier runs after page.close(), so it cannot see the live DOM —
// the probe MUST happen here). It NEVER touches engine3 (CEO Directive #8 —
// engine3 is off-limits): it only rewrites the Engine-9 `searchResult` in place.
//
// Genuine Etrav autosuggest-down (case b — inputs present, no suggestions) is left
// as AUTOSUGGEST_DOWN so Etrav escalation/metrics stay correct.

const logger = require('../utils/logger');

// Canonical Etrav flight-search autosuggest inputs (the same selectors engine3's
// own form-crash guard probes — flightSearchPulse.js:246-249).
const ORIGIN_SELECTOR = 'input[placeholder="Where From ?"]';
const DEST_SELECTOR = 'input[placeholder="Where To ?"]';

const ELIGIBLE_STATUS = 'AUTOSUGGEST_DOWN';
const RECLASSIFIED_STATUS = 'FLIGHT_FORM_NOT_LOADED';

// Probe the still-open page for the flight search form inputs. Best-effort:
// defaults to "present" on any probe error so a genuine Etrav failure is never
// over-reclassified just because the page was mid-navigation / detached.
async function _probeFormInputs(page) {
  try {
    return await page.evaluate(({ originSel, destSel }) => ({
      originPresent: !!document.querySelector(originSel),
      destPresent: !!document.querySelector(destSel),
    }), { originSel: ORIGIN_SELECTOR, destSel: DEST_SELECTOR });
  } catch {
    return { originPresent: true, destPresent: true };
  }
}

// Reclassify a misclassified AUTOSUGGEST_DOWN search result IN PLACE.
//
// If the recorded status is AUTOSUGGEST_DOWN but the live page shows the flight
// search form inputs are ABSENT (the form never loaded), rewrite the result to
// FLIGHT_FORM_NOT_LOADED with an EQIS-side failureReason. Otherwise leave it
// untouched (genuine Etrav autosuggest-down).
//
// @returns {Promise<{reclassified:boolean, from?:string, to?:string, reason:string}>}
async function reclassifyIfFormNeverLoaded({ page, searchResult, meta }) {
  try {
    if (!page || !searchResult || typeof searchResult !== 'object') {
      return { reclassified: false, reason: 'no_input' };
    }
    if (searchResult.searchStatus !== ELIGIBLE_STATUS) {
      return { reclassified: false, reason: 'status_not_eligible' };
    }

    const probe = await _probeFormInputs(page);
    // "Never loaded" only when BOTH autosuggest inputs are absent — a single
    // missing input could be a transient render race, not a page-load failure.
    const formNeverLoaded = !probe.originPresent && !probe.destPresent;
    if (!formNeverLoaded) {
      return { reclassified: false, reason: 'form_present' };
    }

    const sector = (meta && meta.sector) || '';
    searchResult.searchStatus = RECLASSIFIED_STATUS;
    searchResult.reclassifiedFrom = ELIGIBLE_STATUS;
    searchResult.error = 'Flight search form never loaded (origin/destination inputs absent) — EQIS-side page-load failure, not Etrav autosuggest.';
    searchResult.failureReason = 'EQIS ISSUE: Flight search form did not load (the "Where From ?"/"Where To ?" inputs were not on the page) — the engine exited before Etrav autosuggest was exercised. Reclassified from AUTOSUGGEST_DOWN by Engine-9 live-page evidence probe.';

    logger.info('[FLIGHT-INTL-AUDIT] reclassified ' + ELIGIBLE_STATUS + ' → ' +
      RECLASSIFIED_STATUS + (sector ? ' (' + sector + ')' : '') +
      ' — search form never loaded (both autosuggest inputs absent)');

    return { reclassified: true, from: ELIGIBLE_STATUS, to: RECLASSIFIED_STATUS, reason: 'form_never_loaded' };
  } catch (e) {
    logger.warn('[FLIGHT-INTL-AUDIT] reclassifier error (swallowed): ' + e.message);
    return { reclassified: false, reason: 'error: ' + e.message };
  }
}

module.exports = { reclassifyIfFormNeverLoaded, ELIGIBLE_STATUS, RECLASSIFIED_STATUS };
