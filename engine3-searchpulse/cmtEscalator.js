/**
 * CMT Escalator — Auto-escalate DELAY/CRITICAL/FAILURE searches to Etrav CMT.
 *
 * Calls the Etrav ticket API directly: POST /api/v1.0/issue/create (multipart/form-data)
 * Fields: title, description, screenShot (real Playwright screenshot blob), productUrl
 * Auth: accessToken cookie as Bearer header
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ESCALATION_STATE_PATH = path.join(__dirname, '..', 'state', 'cmtEscalations.json');
const MAX_ESCALATIONS_PER_PULSE = 9999;  // No cap — escalate every failure
const COOLDOWN_MS = 0;                   // No cooldown — every occurrence gets escalated
const TICKET_API = 'https://api.codemagen.com/myaccount-service/api/v1.0/issue/create';

function loadEscalationState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ESCALATION_STATE_PATH, 'utf-8'));
  } catch {
    raw = {};
  }
  // Normalize: ensure all fields exist even when file has {} or missing keys
  return {
    escalations: Array.isArray(raw.escalations) ? raw.escalations : [],
    pulseCount: typeof raw.pulseCount === 'number' ? raw.pulseCount : 0,
    nextIssueNumber: typeof raw.nextIssueNumber === 'number' ? raw.nextIssueNumber : 1,
  };
}

function saveEscalationState(state) {
  fs.writeFileSync(ESCALATION_STATE_PATH, JSON.stringify(state, null, 2));
}

function shouldEscalate(sectorOrDest, state) {
  const recent = state.escalations.find(e =>
    e.sector === sectorOrDest && (Date.now() - new Date(e.timestamp).getTime()) < COOLDOWN_MS
  );
  if (recent) {
    logger.info('[CMT] Skipping ' + sectorOrDest + ' — escalated ' + Math.round((Date.now() - new Date(recent.timestamp).getTime()) / 60000) + 'm ago');
    return false;
  }
  return true;
}

function buildTitle(searchResult, rating, issueNumber) {
  const isFlight = !!searchResult.sector;
  const isDom = searchResult.scenarioType === 'domestic';
  const sub = isFlight ? (isDom ? 'SP Flight DOM' : 'SP Flight INTL') : (isDom ? 'SP Hotel DOM' : 'SP Hotel INTL');
  const route = isFlight ? searchResult.sector : searchResult.destination;
  return sub + ' | Issue #' + issueNumber + ' | ' + rating + ' | ' + route;
}

function buildDescription(searchResult, rating) {
  const isFlight = !!searchResult.sector;
  const sec = (searchResult.loadTimeMs / 1000).toFixed(1);
  const eng = isFlight
    ? (searchResult.scenarioType === 'international' ? 'Flight International' : 'Flight Domestic')
    : (searchResult.scenarioType === 'international' ? 'Hotel International' : 'Hotel Domestic');

  var issue = '';
  if (rating === 'FAILURE!!!') {
    issue = searchResult.resultCount === 0
      ? 'Search returned ZERO results — agents unable to book on this route'
      : 'Search took ' + sec + 's (>100s) — classified as FAILURE';
  } else if (rating === 'CRITICAL') {
    issue = 'Search took ' + sec + 's — exceeds critical threshold';
  } else if (rating === 'DELAY') {
    issue = 'Search took ' + sec + 's — exceeds delay threshold';
  }

  const lines = [
    'Search ID: ' + (searchResult.searchId || 'N/A'),
    'Engine: ' + eng,
    isFlight ? ('Sector: ' + searchResult.sector) : ('Destination: ' + searchResult.destination),
    'Search Date: ' + (searchResult.searchDate || 'N/A'),
    'Rating: ' + rating,
    'Duration: ' + sec + 's',
    'Results Found: ' + (searchResult.resultCount || 0),
  ];
  if (isFlight) {
    lines.push('Pax: ' + (searchResult.paxCount || 'N/A'), 'Cabin: ' + (searchResult.cabinClass || 'N/A'), 'Trip: ' + (searchResult.searchType || 'N/A'));
    if (searchResult.airlineCount) lines.push('Airlines: ' + searchResult.airlineCount);
  } else {
    lines.push('Rooms: ' + (searchResult.rooms || 'N/A'), 'Pax: ' + (searchResult.paxCount || 'N/A'), 'Nights: ' + (searchResult.nights || 'N/A'));
  }
  lines.push('');
  lines.push('Issue: ' + issue);
  if (searchResult.searchUrl) {
    lines.push('');
    lines.push('Search URL: ' + searchResult.searchUrl);
  }
  lines.push('');
  lines.push('Reported by: EQIS Automated QA System');
  return lines.join('\n');
}

async function escalateToEtravCMT(page, searchResult, rating, pulseEscalationCount) {
  const isFlight = !!searchResult.sector;
  const sectorOrDest = isFlight ? searchResult.sector : searchResult.destination;

  if (pulseEscalationCount >= MAX_ESCALATIONS_PER_PULSE) {
    logger.info('[CMT] Skipping — pulse limit (' + MAX_ESCALATIONS_PER_PULSE + ') reached');
    return { escalated: false, reason: 'pulse_limit' };
  }

  const state = loadEscalationState();
  if (!shouldEscalate(sectorOrDest, state)) {
    return { escalated: false, reason: 'cooldown' };
  }

  try {
    const issueNum = state.nextIssueNumber || 1;
    const title = buildTitle(searchResult, rating, issueNum);
    const description = buildDescription(searchResult, rating);
    const productUrl = searchResult.searchUrl || page.url();

    logger.info('[CMT] Escalating ' + sectorOrDest + ' (' + rating + ') — Issue #' + issueNum + '...');

    // Take a real Playwright screenshot of the current page
    const screenshotBuffer = await page.screenshot({ type: 'png' });
    const screenshotBase64 = screenshotBuffer.toString('base64');

    // Call the Etrav ticket API with real screenshot + search URL in description
    const apiResult = await page.evaluate(async function(params) {
      try {
        var tokenMatch = document.cookie.match(/accessToken=([^;]+)/);
        var accessToken = tokenMatch ? tokenMatch[1] : '';

        // Convert base64 screenshot to Blob
        var byteChars = atob(params.screenshotBase64);
        var byteArr = new Uint8Array(byteChars.length);
        for (var i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
        var blob = new Blob([byteArr], { type: 'image/png' });

        var formData = new FormData();
        formData.append('title', params.title);
        formData.append('description', params.description);
        formData.append('screenShot', blob, 'eqis-screenshot.png');
        formData.append('productUrl', params.productUrl);

        var headers = {};
        if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
        var resp = await fetch(params.apiUrl, { method: 'POST', body: formData, headers: headers });
        var data = await resp.json().catch(function() { return {}; });
        return { status: resp.status, ok: resp.ok, data: data };
      } catch (e) {
        return { error: e.message };
      }
    }, { title: title, description: description, productUrl: productUrl, screenshotBase64: screenshotBase64, apiUrl: TICKET_API });

    if (apiResult.ok || apiResult.status === 200 || apiResult.status === 201) {
      logger.info('[CMT] Ticket #' + issueNum + ' raised for ' + sectorOrDest + ' (' + rating + ') — API status: ' + apiResult.status);
      state.escalations.push({
        issueNumber: issueNum, sector: sectorOrDest, rating: rating, title: title,
        searchId: searchResult.searchId || '', timestamp: new Date().toISOString(),
      });
      state.nextIssueNumber = issueNum + 1;
      if (state.escalations.length > 200) state.escalations = state.escalations.slice(-200);
      saveEscalationState(state);
      return { escalated: true };
    } else {
      logger.warn('[CMT] Ticket API returned ' + apiResult.status + ': ' + JSON.stringify(apiResult.data || apiResult.error));
      return { escalated: false, reason: 'api_' + apiResult.status };
    }
  } catch (err) {
    logger.error('[CMT] Escalation failed for ' + sectorOrDest + ': ' + err.message);
    return { escalated: false, reason: 'error: ' + err.message };
  }
}

module.exports = { escalateToEtravCMT, MAX_ESCALATIONS_PER_PULSE };
