/**
 * Audit Escalator — Engine 9 (Flight INTL Audit) auto-escalation to Etrav CMT.
 *
 * Whenever a Flight INTL Audit run hits a GENUINE ETRAV-SIDE error on any page
 * (search-results page OR review/itinerary page), raise a CMT ticket — the same
 * backend the on-page "camera icon" (.screenshot-icon-wrapper) triggers:
 *   POST https://api.codemagen.com/myaccount-service/api/v1.0/issue/create
 *   multipart/form-data: title, description, screenShot (real Playwright PNG),
 *   productUrl. Auth: accessToken cookie as Bearer header.
 *
 * The ticket description ALWAYS carries the current error-page URL (page.url()).
 *
 * SCOPE — Etrav-side ONLY (legacy match): genuine Etrav product issues escalate;
 * EQIS-side automation bugs / false positives are SKIPPED so Etrav's team is never
 * spammed with our own noise.
 *
 * GATED OFF by default via env FLIGHT_INTL_AUDIT_ESCALATION_ENABLED (default 'false').
 *
 * Self-contained inside engine9-flightintlaudit/ — does NOT import or modify any
 * engine3-searchpulse/* or engine8-reviewpulse/* file (CEO Directive #8 isolation).
 * Replicates the CMT POST mechanism of engine3-searchpulse/cmtEscalator.js.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ESCALATION_STATE_PATH = path.join(__dirname, '..', 'state', 'auditEscalations.json');
const TICKET_API = 'https://api.codemagen.com/myaccount-service/api/v1.0/issue/create';

// Etrav-side verdicts that warrant a ticket (genuine product issues).
const REVIEW_ETRAV_SIDE = new Set([
  'FAILED_TO_LOAD', 'RESULTS_NOT_LOADED', 'SOLD_OUT', 'PRICE_CHANGED',
  'FARE_UNAVAILABLE', 'SESSION_EXPIRED', 'BANNER_ERROR', 'FARE_CHANGE',
]);
// EQIS-side verdicts (never escalate): BOOK_BTN_MISSING, BOOK_CLICK_NO_NAV,
// REVIEW_LOAD_TIMEOUT, JS_ERROR, REVIEW_BROKEN, TARGET_MISMATCH, SKIPPED,
// REVIEW_OK, UNKNOWN.

function isEnabled() {
  return String(process.env.FLIGHT_INTL_AUDIT_ESCALATION_ENABLED || 'false').toLowerCase() === 'true';
}

function loadEscalationState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ESCALATION_STATE_PATH, 'utf-8'));
  } catch {
    raw = {};
  }
  return {
    escalations: Array.isArray(raw.escalations) ? raw.escalations : [],
    nextIssueNumber: typeof raw.nextIssueNumber === 'number' ? raw.nextIssueNumber : 1,
  };
}

function saveEscalationState(state) {
  fs.writeFileSync(ESCALATION_STATE_PATH, JSON.stringify(state, null, 2));
}

// True only for genuine Etrav search failures where the form actually submitted.
// SPF-like (form never submitted → no /flights/oneway|roundtrip in URL) is skipped.
function _searchIsEtravFailure(sr) {
  if (!sr) return false;
  const url = sr.searchUrl || '';
  const submitted = url.includes('/flights/oneway') || url.includes('/flights/roundtrip');
  if (!submitted) return false;
  const status = sr.searchStatus || '';
  if (status === 'SUCCESS') return false; // search OK — any error is review-side
  const zero = (sr.resultCount || 0) === 0;
  return ['FAILED', 'ZERO_RESULTS', 'AUTOSUGGEST_DOWN', 'ETRAV_FORM_CRASH'].includes(status) ||
    (status !== 'SUCCESS' && zero && submitted);
}

function _humanIssue(reasonLabel, sr, rv, isSearch) {
  if (isSearch) {
    if ((sr.resultCount || 0) === 0) {
      return 'Search returned ZERO results — agents unable to book on this route (' + reasonLabel + ')';
    }
    return 'Search failed on the results page (' + reasonLabel + ')';
  }
  switch (reasonLabel) {
    case 'FAILED_TO_LOAD':     return 'Review/itinerary page never finished rendering (passenger form + continue button absent)';
    case 'RESULTS_NOT_LOADED': return 'Search-results page never populated bookable flight rows';
    case 'SOLD_OUT':           return 'Flight not available / sold out since selection (post-Book modal)';
    case 'PRICE_CHANGED':      return 'Fare price changed after load (Etrav price-change modal)';
    case 'FARE_CHANGE':        return 'Fare changed after load (Etrav Fare Change Alert)';
    case 'FARE_UNAVAILABLE':   return 'Selected fare is no longer available';
    case 'SESSION_EXPIRED':    return 'Agent session expired — kicked back to login on the review page';
    case 'BANNER_ERROR':       return 'Red error banner on the review page';
    default:                   return 'Etrav-side error on the review page (' + reasonLabel + ')';
  }
}

function _buildTitle(issueNum, reasonLabel, sector) {
  return 'FIA Flight INTL | Issue #' + issueNum + ' | ' + reasonLabel + ' | ' + sector;
}

// Render one picked flight (onward or return) as "Airline FlightCode [Fare] ₹Price".
function _formatFlight(t) {
  if (!t || typeof t !== 'object') return '';
  const head = [t.airline, t.flightCode].filter(Boolean).join(' ').trim();
  let s = head;
  if (t.fareLabel) s += ' [' + t.fareLabel + ']';
  if (t.price) s += ' ₹' + t.price;
  return s.trim();
}

// Flight-number line(s) for REVIEW-page errors. The error happened after a flight
// was picked + booked, so reviewResult carries the selected flight(s):
//   one-way   → rv.target = { airline, flightCode, fareLabel, price }
//   roundtrip → rv.target = onward pick, rv.returnTarget = return pick
// Returns [] when no flight was picked (e.g. RESULTS_NOT_LOADED returns before pick).
function _flightLines(rv, isSearch) {
  if (isSearch || !rv) return [];
  const onward = _formatFlight(rv.target);
  const ret = _formatFlight(rv.returnTarget);
  const out = [];
  if (onward && ret) {
    out.push('Onward Flight: ' + onward);
    out.push('Return Flight: ' + ret);
  } else if (onward) {
    out.push('Flight Number: ' + onward);
  }
  return out;
}

function _buildDescription(errorPageUrl, sector, sr, rv, meta, reasonLabel, isSearch) {
  const lines = [
    'Error Page URL: ' + errorPageUrl,
    '',
    '--- SEARCH DETAILS ---',
    'Sector: ' + sector,
    'Passengers: ' + (sr.paxCount || meta.paxCount || 'N/A'),
    'Cabin Class: ' + (sr.cabinClass || meta.cabinClass || 'N/A'),
    'Trip Type: ' + (sr.searchType || meta.tripType || 'N/A'),
    'Search Date: ' + (sr.searchDate || 'N/A'),
    'Results Found: ' + (sr.resultCount || 0),
    'Search URL: ' + (sr.searchUrl || 'N/A'),
    '',
    '--- ERROR DETAILS ---',
    'Search Status: ' + (sr.searchStatus || 'N/A'),
    'Review Verdict: ' + (rv.verdict || 'N/A'),
    'Severity: ' + (rv.severity || sr.severity || 'N/A'),
  ];
  // Flight number(s) — only when the error is on the review/itinerary page.
  for (const fl of _flightLines(rv, isSearch)) lines.push(fl);
  lines.push(
    'Run ID: ' + (meta.runId || 'N/A'),
    '',
    'Issue: ' + _humanIssue(reasonLabel, sr, rv, isSearch),
    '',
    'Reported by: EQIS Automated QA System',
  );
  return lines.join('\n');
}

/**
 * Escalate one Flight INTL Audit run to Etrav CMT if it hit a genuine Etrav-side
 * error. NEVER throws. Returns { escalated:bool, reason?:string }.
 *
 * @param {Object} args { page, searchResult, reviewResult, meta }
 *   meta = { runId, sector, tripType, cabinClass }
 */
async function escalateAuditError(args) {
  const { page } = args || {};
  const sr = (args && args.searchResult) || {};
  const rv = (args && args.reviewResult) || {};
  const meta = (args && args.meta) || {};

  if (!isEnabled()) return { escalated: false, reason: 'disabled' };
  if (!page) return { escalated: false, reason: 'no_page' };

  const searchFail = _searchIsEtravFailure(sr);
  const reviewFail = !!(rv && REVIEW_ETRAV_SIDE.has(rv.verdict));
  if (!searchFail && !reviewFail) return { escalated: false, reason: 'not_etrav_side' };

  const isSearch = searchFail;
  const reasonLabel = isSearch ? (sr.searchStatus || 'SEARCH_FAILED') : rv.verdict;
  const sector = meta.sector || sr.sector || 'N/A';

  try {
    const state = loadEscalationState();
    const issueNum = state.nextIssueNumber || 1;
    const errorPageUrl = page.url();
    const title = _buildTitle(issueNum, reasonLabel, sector);
    const description = _buildDescription(errorPageUrl, sector, sr, rv, meta, reasonLabel, isSearch);
    const productUrl = sr.searchUrl || errorPageUrl;

    logger.info('[FLIGHT-INTL-AUDIT] CMT: escalating ' + sector + ' (' + reasonLabel + ') — Issue #' + issueNum + '...');

    // Real Playwright screenshot of the current (error) page.
    let screenshotBase64 = '';
    try {
      const buf = await page.screenshot({ type: 'png' });
      screenshotBase64 = buf.toString('base64');
    } catch (ssErr) {
      logger.warn('[FLIGHT-INTL-AUDIT] CMT: screenshot failed — ' + ssErr.message);
    }

    const apiResult = await page.evaluate(async function (params) {
      try {
        var tokenMatch = document.cookie.match(/accessToken=([^;]+)/);
        var accessToken = tokenMatch ? tokenMatch[1] : '';

        var formData = new FormData();
        formData.append('title', params.title);
        formData.append('description', params.description);
        if (params.screenshotBase64) {
          var byteChars = atob(params.screenshotBase64);
          var byteArr = new Uint8Array(byteChars.length);
          for (var i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
          var blob = new Blob([byteArr], { type: 'image/png' });
          formData.append('screenShot', blob, 'eqis-fia-screenshot.png');
        }
        formData.append('productUrl', params.productUrl);

        var headers = {};
        if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
        var resp = await fetch(params.apiUrl, { method: 'POST', body: formData, headers: headers });
        var data = await resp.json().catch(function () { return {}; });
        return { status: resp.status, ok: resp.ok, data: data };
      } catch (e) {
        return { error: e.message };
      }
    }, { title: title, description: description, productUrl: productUrl, screenshotBase64: screenshotBase64, apiUrl: TICKET_API });

    if (apiResult.ok || apiResult.status === 200 || apiResult.status === 201) {
      logger.info('[FLIGHT-INTL-AUDIT] CMT: Ticket #' + issueNum + ' raised for ' + sector + ' (' + reasonLabel + ') — API status: ' + apiResult.status);
      state.escalations.push({
        issueNumber: issueNum,
        sector: sector,
        reason: reasonLabel,
        verdict: rv.verdict || '',
        searchStatus: sr.searchStatus || '',
        paxCount: sr.paxCount || meta.paxCount || '',
        cabinClass: sr.cabinClass || meta.cabinClass || '',
        tripType: sr.searchType || meta.tripType || '',
        onwardFlight: (rv.target && rv.target.flightCode) || '',
        returnFlight: (rv.returnTarget && rv.returnTarget.flightCode) || '',
        runId: meta.runId || '',
        errorPageUrl: errorPageUrl,
        timestamp: new Date().toISOString(),
      });
      state.nextIssueNumber = issueNum + 1;
      if (state.escalations.length > 200) state.escalations = state.escalations.slice(-200);
      saveEscalationState(state);
      return { escalated: true, reason: reasonLabel, issueNumber: issueNum };
    }

    logger.warn('[FLIGHT-INTL-AUDIT] CMT: Ticket API returned ' + apiResult.status + ': ' + JSON.stringify(apiResult.data || apiResult.error));
    return { escalated: false, reason: 'api_' + (apiResult.status || apiResult.error || 'unknown') };
  } catch (err) {
    logger.error('[FLIGHT-INTL-AUDIT] CMT: escalation failed for ' + sector + ': ' + err.message);
    return { escalated: false, reason: 'error: ' + err.message };
  }
}

module.exports = { escalateAuditError, isEnabled, REVIEW_ETRAV_SIDE };
