// flightIntlAuditEngine.js — Engine 9: merged Flight INTL Audit.
//
// One continuous run on ONE page/context:
//   login → INTL search (Engine 3 core) → results-page audit
//        → book + review-page audit (Engine 8 core) → evidence + recording.
//
// WHY MERGED (user 2026-06-18): SearchPulse Flight INTL and the Review Pulse
// engine are a single continuous user journey (search → pick a fare → Book →
// review/itinerary page). Running them on the SAME page in one recording gives
// one unbroken video search→book→review and one unified verdict per run, with
// no second browser, no re-navigation to the results URL, and no re-polling.
//
// SAFETY / ISOLATION:
//   * This engine is ADDITIVE. It does NOT modify or pause Engine 3 SearchPulse
//     or Engine 8 Review — both keep running unchanged (user constraint
//     2026-06-18: "dont remove the flight intl as well as review engine until
//     the new engine is built and perfectly working").
//   * It REUSES the proven cores untouched:
//       - engine3-searchpulse/flightSearchPulse.runFlightSearchPulse(page,
//         scenario, pulseId, { skipReviewHook:true })  — runs the search on the
//         provided page and (on SUCCESS) leaves it on the results URL. The
//         skipReviewHook flag suppresses the legacy fire-and-forget own-browser
//         review so we can run it INLINE on the same page instead.
//       - engine8-reviewpulse/flightIntlReviewPulse.runOnce({ page, ... }) —
//         books a fare + audits the review page on the page already at results.
//   * Recording + evidence capture + the dedicated RoundTrip-Fare rotation are
//     self-contained in this engine9 folder (auditRecording.js, rtFareRotation.js)
//     so the protected Review engine (CEO Directive #1/#6) is never coupled.
//   * Own Chromium per run (never shares a parent browser), bounded review
//     timeout, all errors swallowed → always returns/writes a row.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const { getLocalDateString } = require('../utils/timezone');
const login = require('../utils/etravLogin');
const searchPulseActivity = require('../utils/searchPulseActivity');
const { pickPulseScenarios } = require('../engine3-searchpulse/pulsePicker');
const { runFlightSearchPulse } = require('../engine3-searchpulse/flightSearchPulse');
const flightIntl = require('../engine8-reviewpulse/flightIntlReviewPulse');
const reviewPulseEngine = require('../engine8-reviewpulse/reviewPulseEngine');
const audit = require('./auditRecording');
const rtFareRotation = require('./rtFareRotation');
const auditEscalator = require('./auditEscalator');
const auditVerifier = require('./auditVerifier');
const auditReclassifier = require('./auditReclassifier');
const auditFormRecovery = require('./auditFormRecovery');
const trendCache = require('../utils/trendCache');

const ACTIVITY_CATEGORY = 'flight-intl-audit';
const VIEWPORT = { width: 1440, height: 900 };
const REVIEW_HARD_TIMEOUT_MS = reviewPulseEngine.HARD_TIMEOUT_MS || 180000;

const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'flight-intl-audit');
const SHOTS_DIR   = path.join(REPORTS_DIR, 'screenshots');
const RECS_DIR    = path.join(REPORTS_DIR, 'recordings');

// ── single-flight lock (self-throttle overlapping cron ticks) ───────────────
let _running = false;
let _runningSince = 0;
const _LOCK_WATCHDOG_MS = 10 * 60 * 1000; // 10 min — above review HARD_TIMEOUT
function _tryAcquireLock() {
  if (_running) {
    if (Date.now() - _runningSince < _LOCK_WATCHDOG_MS) return false;
    logger.warn('[FLIGHT-INTL-AUDIT] watchdog: force-releasing stale lock (held ' +
      Math.round((Date.now() - _runningSince) / 1000) + 's)');
  }
  _running = true; _runningSince = Date.now();
  return true;
}
function _releaseLock() { _running = false; _runningSince = 0; }

function isEnabled() {
  return String(process.env.FLIGHT_INTL_AUDIT_ENABLED || 'true').toLowerCase() !== 'false';
}

function _todayIso() { return getLocalDateString(); } // IST date — aligns report file name with dashboard "Today"
function _newRunId() {
  return 'FIA-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

function _appendDailyReport(row) {
  audit.ensureDir(REPORTS_DIR);
  const filePath = path.join(REPORTS_DIR, 'AUDIT-' + _todayIso() + '.json');
  let data = { date: _todayIso(), rows: [] };
  try { if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { /* corrupt — start fresh */ }
  if (!Array.isArray(data.rows)) data.rows = [];
  data.rows.push(row);
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); }
  catch (e) { logger.warn('[FLIGHT-INTL-AUDIT] write daily report failed: ' + e.message); }
}

function _withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true, tag }), ms)),
  ]);
}

// Pick a single international flight scenario for this run, reusing the proven
// pulsePicker (date/trip/pax/cabin distribution all preserved). For round-trip
// runs, OVERRIDE the shared roundTripFareShouldBeChecked with this engine's own
// isolated alternation so the intl ticked/unticked rhythm never drifts.
function _pickIntlScenario() {
  let trendData = {};
  try { trendData = trendCache.read() || {}; } catch {}
  const { flightSearches } = pickPulseScenarios(trendData);
  const intl = (flightSearches || []).filter(s => s.type === 'international');
  const scenario = intl[0] || (flightSearches || [])[0] || null;
  if (!scenario) return null;
  // Force international so downstream INTL branches engage even on a fallback.
  scenario.type = 'international';
  let rtFareChecked = null;
  if (scenario.tripType === 'round-trip') {
    const rot = rtFareRotation.nextChecked();
    scenario.roundTripFareShouldBeChecked = rot.shouldBeChecked;
    scenario.roundTripCounter = rot.counter;
    rtFareChecked = rot.shouldBeChecked;
  }
  return { scenario, rtFareChecked };
}

/**
 * Run one Flight INTL Audit. NEVER throws — always returns a row object (or null
 * when disabled / already running).
 */
async function runFlightIntlAudit() {
  if (!isEnabled()) {
    logger.info('[FLIGHT-INTL-AUDIT] disabled via FLIGHT_INTL_AUDIT_ENABLED=false');
    return null;
  }
  if (!_tryAcquireLock()) {
    logger.info('[FLIGHT-INTL-AUDIT] skipped — previous run still in progress');
    return { skipped: true, reason: 'already_running' };
  }
  try {
    return await _runInternal();
  } finally {
    _releaseLock();
  }
}

async function _runInternal() {
  const runId = _newRunId();
  audit.ensureDir(SHOTS_DIR); audit.ensureDir(RECS_DIR);
  const tmpVideoDir = path.join(RECS_DIR, 'tmp-' + runId);
  audit.ensureDir(tmpVideoDir);
  const shotRel = 'screenshots/audit-' + runId + '.png';
  const shotAbs = path.join(REPORTS_DIR, shotRel);
  const paxShotRel = 'screenshots/audit-' + runId + '-passenger.png';
  const paxShotAbs = path.join(REPORTS_DIR, paxShotRel);

  const picked = _pickIntlScenario();
  if (!picked) {
    logger.warn('[FLIGHT-INTL-AUDIT] no international scenario available — skipping');
    return { skipped: true, reason: 'no_intl_scenario' };
  }
  const scenario = picked.scenario;
  const sector = { from: scenario.from, to: scenario.to };
  const tag = 'flight-intl ' + (sector.from || '?') + '->' + (sector.to || '?');
  const pulseId = 'AUDIT-' + getLocalDateString() + '-' + runId.slice(-6);
  try { searchPulseActivity.set(ACTIVITY_CATEGORY, 'search', 'Searching ' + (sector.from || '?') + '→' + (sector.to || '?') + ' ' + (scenario.cabinClass || 'Economy')); } catch {}

  logger.info('[FLIGHT-INTL-AUDIT] start ' + tag + ' runId=' + runId +
    ' trip=' + (scenario.tripType || 'one-way') +
    (picked.rtFareChecked === null ? '' : ' rtFare=' + (picked.rtFareChecked ? 'checked' : 'unchecked')));

  const startedAtMs = Date.now();
  let browser = null, context = null, page = null;
  let searchResult = null, reviewResult = null;

  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: settings.HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    context = await browser.newContext({
      viewport: VIEWPORT,
      locale: 'en-IN',
      timezoneId: settings.TIMEZONE,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      recordVideo: { dir: tmpVideoDir, size: VIEWPORT },
    });
    // Cursor overlay so pointer moves + click pulses are visible in the video.
    await context.addInitScript(audit.cursorOverlayInit);
    page = await context.newPage();
    page.setDefaultTimeout(30000);

    // In-context login (fresh, valid Etrav session cookies — a deep goto to
    // /flights from a restored-cookie context gets server-redirected to the
    // marketing site; logging in here avoids that). runFlightSearchPulse then
    // navigates to /flights itself via its own URL-match guard.
    await login.authenticate(page);

    const recordStartedAt = Date.now(); // anchor for the review's video markers

    // ── PHASE A: Flight INTL search on this page (legacy review hook skipped) ──
    searchResult = await runFlightSearchPulse(page, scenario, pulseId, { skipReviewHook: true });

    // ── RECLASSIFY PHASE A (Engine 9): split misclassified AUTOSUGGEST_DOWN ──
    // engine3 labels BOTH "form never loaded" and "Etrav returned no suggestions"
    // as AUTOSUGGEST_DOWN. The page is STILL OPEN here, so probe the live DOM: if
    // the flight-search inputs are absent, re-label to FLIGHT_FORM_NOT_LOADED
    // (EQIS-side) so the run isn't wrongly blamed on Etrav. Engine3 untouched.
    try {
      await auditReclassifier.reclassifyIfFormNeverLoaded({
        page, searchResult,
        meta: { runId, sector: (sector.from || '') + '→' + (sector.to || '') },
      });
    } catch (rcErr) {
      logger.warn('[FLIGHT-INTL-AUDIT] reclassify error (swallowed): ' + rcErr.message);
    }

    // ── RECOVERY PHASE (Engine 9): self-heal a FLIGHT_FORM_NOT_LOADED stumble ──
    // If PHASE A ended on the post-login dashboard (no search form), the search
    // never really ran — an EQIS-side stumble, not an Etrav failure. Click the
    // in-app Flights tab (SPA route avoids the Directive #2 redirect) to surface
    // the form, then re-run the engine3 search ONCE. Bounded single retry; own
    // try/catch so a recovery failure never aborts the run. Engine3 untouched.
    try {
      if (((searchResult && searchResult.searchStatus) || '') === auditReclassifier.RECLASSIFIED_STATUS) {
        const recMeta = { runId, sector: (sector.from || '') + '→' + (sector.to || '') };
        const recovery = await auditFormRecovery.recoverFlightForm({ page, meta: recMeta });
        if (recovery && recovery.recovered && recovery.method !== 'already_present') {
          logger.info('[FLIGHT-INTL-AUDIT] form recovered via ' + recovery.method + ' — re-running search ' + tag);
          searchResult = await runFlightSearchPulse(page, scenario, pulseId, { skipReviewHook: true });
          try {
            await auditReclassifier.reclassifyIfFormNeverLoaded({ page, searchResult, meta: recMeta });
          } catch (rc2Err) {
            logger.warn('[FLIGHT-INTL-AUDIT] reclassify-after-recovery error (swallowed): ' + rc2Err.message);
          }
        }
        if (searchResult && typeof searchResult === 'object') searchResult.formRecovery = recovery;
      }
    } catch (recErr) {
      logger.warn('[FLIGHT-INTL-AUDIT] form recovery error (swallowed): ' + recErr.message);
    }

    const searchStatus = (searchResult && searchResult.searchStatus) || 'UNKNOWN';
    logger.info('[FLIGHT-INTL-AUDIT] search ' + tag + ' status=' + searchStatus +
      ' results=' + (searchResult && searchResult.resultCount) + ' ' + (searchResult && searchResult.loadTimeMs) + 'ms');

    // ── PHASE B: review/booking audit on the SAME page (only if search loaded) ─
    if (searchStatus === 'SUCCESS') {
      try { searchPulseActivity.set(ACTIVITY_CATEGORY, 'review', 'Booking + review audit ' + (sector.from || '?') + '→' + (sector.to || '?')); } catch {}
      const partialResult = { events: [] };
      const subArgs = { page, sector, scenario, runId, recordStartedAt, partialResult };
      reviewResult = await _withTimeout(flightIntl.runOnce(subArgs), REVIEW_HARD_TIMEOUT_MS, tag);
      if (reviewResult && reviewResult.timedOut) {
        reviewResult = {
          sector: tag,
          error: 'HARD_TIMEOUT after ' + REVIEW_HARD_TIMEOUT_MS + 'ms',
          verdict: 'REVIEW_LOAD_TIMEOUT',
          severity: 'P1',
          startedAt: new Date(recordStartedAt).toISOString(),
          durationMs: Date.now() - recordStartedAt,
          events: (partialResult.events || []).slice(),
          populatedRowsAfterWait: partialResult.populatedRowsAfterWait,
          target: partialResult.target || null,
        };
      }
    } else {
      // Search never produced a usable results page → no booking to review.
      reviewResult = {
        sector: tag,
        verdict: 'SKIPPED',
        severity: 'INFO',
        reason: 'search_status_' + searchStatus,
        startedAt: new Date(recordStartedAt).toISOString(),
        durationMs: 0,
        events: [],
      };
      logger.info('[FLIGHT-INTL-AUDIT] review SKIPPED — search not SUCCESS (' + searchStatus + ')');
    }

    // ── Evidence shots + hold so the final video frames stay readable. ──
    // Passenger-details screenshot is ONLY relevant when the flow reached the
    // review/itinerary page (PHASE B ran, i.e. search SUCCESS). When the search
    // never produced a results page (review SKIPPED) there is no passenger area
    // to capture, so skip it and only keep the top/final viewport shot.
    const reachedReviewPage = searchStatus === 'SUCCESS';
    await audit.captureEvidenceShots(page, {
      topShotAbs: shotAbs,
      paxShotAbs: reachedReviewPage ? paxShotAbs : null,
      holdMs: 5000,
    });
    if (reviewResult && typeof reviewResult === 'object') {
      reviewResult.recordingDurationMs = Date.now() - recordStartedAt;
    }

    // ── CMT ESCALATION PHASE (Engine 9, gated OFF by default) ──
    // Page is still open and sitting on the actual error page, so page.url() is
    // the current error-page URL. Etrav-side errors only; own try/catch so an
    // escalation failure never aborts the run.
    try {
      if (auditEscalator.isEnabled()) {
        const _pax = scenario.passengers || {};
        const _paxParts = [];
        if (_pax.adults) _paxParts.push(_pax.adults + 'A');
        if (_pax.children) _paxParts.push(_pax.children + 'C');
        if (_pax.infants) _paxParts.push(_pax.infants + 'I');
        const meta = {
          runId,
          sector: (sector.from || '') + '→' + (sector.to || ''),
          tripType: scenario.tripType,
          cabinClass: scenario.cabinClass,
          paxCount: _paxParts.join(' ') || '',
        };
        const esc = await auditEscalator.escalateAuditError({ page, searchResult, reviewResult, meta });
        if (reviewResult && typeof reviewResult === 'object') reviewResult.cmtEscalation = esc;
        if (esc.escalated) logger.info('[FLIGHT-INTL-AUDIT] CMT ticket raised: ' + esc.reason + ' (Issue #' + esc.issueNumber + ')');
      }
    } catch (escErr) {
      logger.warn('[FLIGHT-INTL-AUDIT] CMT escalation error (swallowed): ' + escErr.message);
    }
  } catch (e) {
    logger.warn('[FLIGHT-INTL-AUDIT] swallowed error: ' + e.message);
    if (!reviewResult) reviewResult = { sector: tag, error: e.message, verdict: 'REVIEW_BROKEN', severity: 'P2', startedAt: new Date(startedAtMs).toISOString() };
    if (page) { try { await page.evaluate(function () { window.scrollTo(0, 0); }).catch(function () {}); await page.screenshot({ path: shotAbs }); await page.waitForTimeout(3000); } catch {} }
  } finally {
    if (page)    { try { await page.close();    } catch {} }
    if (context) { try { await context.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
  }

  const recordingRel = audit.finalizeRecording(tmpVideoDir, runId, RECS_DIR, REPORTS_DIR);
  const row = _buildRow({ runId, startedAtMs, scenario, sector, rtFareChecked: picked.rtFareChecked, searchResult, reviewResult, shotAbs, shotRel, paxShotAbs, paxShotRel, recordingRel });
  try { _appendDailyReport(row); } catch {}

  // ── FRAKA VIDEO-VS-DATA VERIFY PHASE (Engine 9, gated OFF by default) ──
  // After the row + evidence are persisted, FRAKA re-checks the recording/screenshots
  // against the recorded data. Own try/catch so a verify failure never affects the run.
  try {
    if (auditVerifier.isEnabled()) {
      const v = await auditVerifier.verifyRun({ row });
      if (v && v.verified && v.verdict) {
        logger.info('[FLIGHT-INTL-AUDIT] FRAKA verify: ' + v.verdict.overallVerdict + ' [' + v.verdict.side + '] runId=' + runId);
      }
    }
  } catch (vErr) {
    logger.warn('[FLIGHT-INTL-AUDIT] FRAKA verify error (swallowed): ' + vErr.message);
  }
  try { searchPulseActivity.setIdle(ACTIVITY_CATEGORY, 'Last: search=' + row.search.status + ' review=' + row.review.verdict); } catch {}
  logger.info('[FLIGHT-INTL-AUDIT] done ' + tag + ' runId=' + runId +
    ' search=' + row.search.status + ' review=' + row.review.verdict + ' durationMs=' + row.durationMs);
  return row;
}

// Unified row: one record per run carrying BOTH the search-page outcome and the
// review-page verdict, plus shared evidence (video + screenshots). The review
// fields are flattened at top-level (verdict/severity/screenshotPath/…) so the
// Phase-4 dashboard (adapted from reviewApi) can reuse the Review row shape,
// with an extra `search` block for the search-page side.
function _buildRow(a) {
  const sr = a.searchResult || {};
  const rv = a.reviewResult || {};
  return {
    runId: a.runId,
    startedAt: new Date(a.startedAtMs).toISOString(),
    durationMs: Date.now() - a.startedAtMs,
    sector: (a.sector.from || '') + '→' + (a.sector.to || ''),
    scenarioId: a.scenario.id || a.scenario.scenarioId || '',
    scenarioType: 'international',
    tripType: a.scenario.tripType || 'one-way',
    cabinClass: a.scenario.cabinClass || 'Economy',
    paxCount: sr.paxCount || '',
    searchDate: sr.searchDate || '',
    roundTripFareChecked: a.rtFareChecked, // bool for round-trip, null for one-way

    // ── search-page side ──
    search: {
      status: sr.searchStatus || 'UNKNOWN',
      resultCount: sr.resultCount || 0,
      loadTimeMs: sr.loadTimeMs || 0,
      searchUrl: sr.searchUrl || '',
      airlineCount: sr.airlineCount || 0,
      failureReason: sr.failureReason || '',
      formRecovery: sr.formRecovery || null,
    },

    // ── review/booking-page side (flattened, Review-row compatible) ──
    review: {
      verdict: rv.verdict || 'UNKNOWN',
      severity: rv.severity || '',
      target: rv.target || null,
      metrics: rv.metrics || null,
      error: rv.error || '',
      reason: rv.reason || '',
      durationMs: rv.durationMs || 0,
      populatedRowsAfterWait: rv.populatedRowsAfterWait,
    },

    // top-level mirrors of the most-used review fields + shared assets
    verdict: rv.verdict || 'UNKNOWN',
    severity: rv.severity || '',
    target: rv.target || null,
    events: Array.isArray(rv.events) ? rv.events : [],
    recordingDurationMs: rv.recordingDurationMs || 0,
    screenshotPath: fs.existsSync(a.shotAbs) ? a.shotRel : null,
    passengerShotPath: fs.existsSync(a.paxShotAbs) ? a.paxShotRel : null,
    recordingPath: a.recordingRel || null,
  };
}

module.exports = { runFlightIntlAudit, isEnabled, REPORTS_DIR, REVIEW_HARD_TIMEOUT_MS };
