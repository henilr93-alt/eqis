// reviewPulseEngine.js — Top-level Review Pulse entry called from
// SearchPulse hooks.
//
// SAFETY MODEL (CEO Directives #13 Zero-SPF + #14 SearchPulse auto-protect):
//   * Review ALWAYS opens its OWN BrowserContext off the parent context's
//     browser, copying the parent's storageState (cookies/auth) so login is
//     reused without a re-login round-trip. SearchPulse's context can close
//     at any time without affecting Review's lifecycle.
//   * Engine is called FIRE-AND-FORGET from the hook (no await in SearchPulse).
//   * Bounded overall timeout (HARD_TIMEOUT_MS, default 180s)
//   * All errors swallowed and logged
//   * Env kill-switch: REVIEW_PULSE_ENABLED=false disables instantly
//   * Per-attempt report appended to reports/review/REVIEW-{YYYY-MM-DD}.json
//   * Each attempt is assigned a unique runId. The recording covers from the
//     loaded search page through the Book click + review-page navigation; a
//     final screenshot is taken just before the context closes.
//
// Public API:
//   isEnabled() : boolean
//   runForFlightIntl({ context, searchResultsUrl, sector, scenario })

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const logger = require('../utils/logger');
const flightIntl = require('./flightIntlReviewPulse');

const HARD_TIMEOUT_MS = 180000;
const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'review');
const SHOTS_DIR   = path.join(REPORTS_DIR, 'screenshots');
const RECS_DIR    = path.join(REPORTS_DIR, 'recordings');
const VIEWPORT = { width: 1440, height: 900 };

function isEnabled() {
  // Default ENABLED; set REVIEW_PULSE_ENABLED=false in .env to kill.
  return String(process.env.REVIEW_PULSE_ENABLED || 'true').toLowerCase() !== 'false';
}

function _todayIso() { return require('../utils/timezone').getLocalDateString(); } // IST date — keep report file name aligned with the dashboard "Today" filter
function _ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
function _newRunId() {
  return 'REV-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

function _appendDailyReport(row) {
  _ensureDir(REPORTS_DIR);
  const filePath = path.join(REPORTS_DIR, 'REVIEW-' + _todayIso() + '.json');
  let data = { date: _todayIso(), rows: [] };
  try { if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { /* corrupt — start fresh */ }
  if (!Array.isArray(data.rows)) data.rows = [];
  data.rows.push(row);
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); }
  catch (e) { logger.warn('[REVIEW-ENGINE] write daily report failed: ' + e.message); }
}

function _withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true, tag }), ms)),
  ]);
}

// After the context closes, Playwright finalises the .webm into the tmp dir.
// Pick it up and rename to a stable, runId-keyed path under recordings/.
async function _finalizeRecording(tmpDir, runId) {
  try {
    if (!fs.existsSync(tmpDir)) return null;
    const files = fs.readdirSync(tmpDir).filter(function(f) { return /\.webm$/i.test(f); });
    if (!files.length) return null;
    _ensureDir(RECS_DIR);
    const src = path.join(tmpDir, files[0]);
    // Transcode WebM → MP4 with faststart so the browser progress bar can seek
    // to any timestamp. Raw Playwright WebM has no cues block and is not
    // seekable. MP4 + faststart puts the moov atom at the front for instant
    // streaming + arbitrary seeks.
    const mp4Dst = path.join(RECS_DIR, 'review-' + runId + '.mp4');
    try {
      execSync(
        'ffmpeg -y -i "' + src + '" -c:v libx264 -preset veryfast -crf 28 ' +
        '-movflags +faststart -pix_fmt yuv420p -an "' + mp4Dst + '"',
        { stdio: 'pipe', timeout: 60000 }
      );
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return 'recordings/review-' + runId + '.mp4';
    } catch (ffErr) {
      // Fallback: keep the .webm (cant seek but better than nothing)
      logger.warn('[REVIEW-ENGINE] ffmpeg transcode failed, keeping .webm: ' + (ffErr && ffErr.message ? ffErr.message.split('\n')[0] : 'unknown'));
      const webmDst = path.join(RECS_DIR, 'review-' + runId + '.webm');
      try { fs.renameSync(src, webmDst); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return fs.existsSync(webmDst) ? 'recordings/review-' + runId + '.webm' : null;
    }
  } catch (e) {
    logger.warn('[REVIEW-ENGINE] finalize recording failed: ' + e.message);
    return null;
  }
}

/**
 * Run a Review Pulse attempt for a successfully-completed Flight INTL search.
 * NEVER throws. Always returns a result object (or null on disabled).
 *
 * Opens its OWN BrowserContext (copying the parent's storageState so the Etrav
 * session is reused) and runs entirely inside it. This decouples Review from
 * SearchPulse's context lifecycle — SearchPulse can close at any time.
 *
 * @param {Object} args
 *   context           Playwright BrowserContext (SearchPulse's — used only to
 *                     read storageState + access the underlying browser)
 *   searchResultsUrl  string — Etrav results-page URL (with full search params)
 *   sector            { from, to }
 *   scenario          (optional)
 */
async function runForFlightIntl(args) {
  if (!isEnabled()) {
    logger.info('[REVIEW-ENGINE] disabled via REVIEW_PULSE_ENABLED=false');
    return null;
  }
  args = args || {};
  const sector = args.sector || { from: '?', to: '?' };
  const tag = 'flight-intl ' + (sector.from || '?') + '->' + (sector.to || '?');
  if (!args.context || !args.searchResultsUrl) {
    logger.warn('[REVIEW-ENGINE] missing context or searchResultsUrl, skipping ' + tag);
    return null;
  }

  const runId = _newRunId();
  _ensureDir(SHOTS_DIR); _ensureDir(RECS_DIR);
  const tmpVideoDir = path.join(RECS_DIR, 'tmp-' + runId);
  _ensureDir(tmpVideoDir);
  const shotRel = 'screenshots/review-' + runId + '.png';
  const shotAbs = path.join(REPORTS_DIR, shotRel);
  const paxShotRel = 'screenshots/review-' + runId + '-passenger.png';
  const paxShotAbs = path.join(REPORTS_DIR, paxShotRel);

  logger.info('[REVIEW-ENGINE] start ' + tag + ' runId=' + runId);
  let result, ownBrowser = null, ownContext = null, ownPage = null;
  try {
    // 2026-06-14: launch our OWN Chromium so when SearchPulse tears down its
    // browser at the end of its pulse, this engine is not orphaned. Previously
    // we used args.context.browser() which IS the parent SearchPulse browser —
    // when that closed, our context closed with it (REVIEW_BROKEN:
    // "Target page, context or browser has been closed"). Snapshot the
    // parent's storageState first so the Etrav session cookies are reused
    // and we don't need to re-login.
    let storageState = null;
    try { storageState = await args.context.storageState(); } catch {}
    const { chromium } = require('playwright');
    const settings   = require('../config/settings');
    ownBrowser = await chromium.launch({
      headless: settings.HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    ownContext = await ownBrowser.newContext({
      storageState,
      viewport: VIEWPORT,
      recordVideo: { dir: tmpVideoDir, size: VIEWPORT },
    });
    // Inject a virtual cursor overlay so the recording shows pointer movement
    // and click pulses (Playwright's recordVideo does not capture the OS
    // cursor by default).
    await ownContext.addInitScript(function() {
      try {
        if (window.__rpCursorInstalled) return;
        window.__rpCursorInstalled = true;
        var install = function() {
          if (!document.body) return;
          var dot = document.createElement('div');
          dot.id = '__rp_cursor__';
          dot.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:rgba(255,0,80,0.85);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.4),0 2px 6px rgba(0,0,0,0.35);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:transform 0.06s linear;';
          document.body.appendChild(dot);
          document.addEventListener('mousemove', function(e) {
            dot.style.left = e.clientX + 'px';
            dot.style.top  = e.clientY + 'px';
          }, true);
          var pulse = function(e) {
            var ring = document.createElement('div');
            ring.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;width:10px;height:10px;border-radius:50%;border:3px solid rgba(255,0,80,0.85);pointer-events:none;z-index:2147483646;transform:translate(-50%,-50%);transition:all 0.55s ease-out;opacity:1;';
            document.body.appendChild(ring);
            requestAnimationFrame(function() {
              ring.style.width = '70px';
              ring.style.height = '70px';
              ring.style.opacity = '0';
            });
            setTimeout(function() { if (ring.parentNode) ring.parentNode.removeChild(ring); }, 600);
          };
          document.addEventListener('mousedown', pulse, true);
          document.addEventListener('click',     pulse, true);
        };
        if (document.body) install();
        else document.addEventListener('DOMContentLoaded', install);
      } catch (e) {}
    });
    ownPage = await ownContext.newPage();
    const recordStartedAt = Date.now(); // anchor for video timeline markers
    await ownPage.goto(args.searchResultsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // 2026-06-15: pass a partialResult ref so the inner runOnce can stream
    // events into it. If HARD_TIMEOUT fires while runOnce is still polling,
    // we still keep the events captured so far (otherwise the dashboard shows
    // an empty timeline for every REVIEW_LOAD_TIMEOUT).
    const partialResult = { events: [] };
    const subArgs = { page: ownPage, sector: args.sector, scenario: args.scenario, runId: runId, recordStartedAt: recordStartedAt, partialResult: partialResult };
    result = await _withTimeout(flightIntl.runOnce(subArgs), HARD_TIMEOUT_MS, tag);
    // After the run, record total recording duration so the dashboard can map
    // marker tsMs → percentage of the final video length.
    if (result && typeof result === 'object') result.recordingDurationMs = Date.now() - recordStartedAt;
    if (result && result.timedOut) {
      // 2026-06-15: preserve partial events array so the dashboard timeline
      // still shows where the engine got stuck (Review engine started -> Waiting
      // for results -> ...).
      result = {
        sector:     tag,
        error:      'HARD_TIMEOUT after ' + HARD_TIMEOUT_MS + 'ms',
        verdict:    'REVIEW_LOAD_TIMEOUT',
        severity:   'P1',
        startedAt:  new Date(recordStartedAt).toISOString(),
        durationMs: Date.now() - recordStartedAt,
        events:     (partialResult.events || []).slice(),
        populatedRowsAfterWait: partialResult.populatedRowsAfterWait,
        target:     partialResult.target || null,
      };
    }
    // Final capture — VIEWPORT-ONLY (no fullPage). A fullPage screenshot
    // resizes the viewport to the whole page height while the video is still
    // recording, so Playwright scales the page down to fit the fixed video
    // frame for the rest of the clip — that was the "zoom out" that made the
    // last seconds of the video (incl. any dialog / error banner) unreadable.
    // Viewport-only keeps the on-screen UI at normal scale in both the PNG and
    // the video. We then hold the recording ~5s so the dialog / error box is
    // clearly visible for the final 4-5 seconds of the clip, and the PNG covers
    // only that same on-screen area.
    try {
      // (a) Readable top viewport shot — used for the video's final frame.
      await ownPage.evaluate(function() { window.scrollTo(0, 0); }).catch(function() {});
      await ownPage.screenshot({ path: shotAbs });
      // (b) Passenger-area evidence shot — scroll the Passenger/Traveller
      // section into view and capture VIEWPORT-ONLY (no fullPage, so the video
      // never zooms out). This is the region FAILED_TO_LOAD / REVIEW_BROKEN is
      // about, so the report must show it to tell a real Etrav failure apart
      // from an EQIS detection miss.
      try {
        await ownPage.evaluate(function() {
          var rx = /(passenger details|travellers? details|traveler details|fill my details)/i;
          var els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,section,label,span,p,strong,b');
          var best = null;
          for (var i = 0; i < els.length; i++) {
            var own = '';
            var cn = els[i].childNodes;
            for (var j = 0; j < cn.length; j++) if (cn[j].nodeType === 3) own += cn[j].textContent;
            if (rx.test(own.trim())) { best = els[i]; break; }
          }
          if (best) best.scrollIntoView({ block: 'start' });
          else window.scrollTo(0, Math.round((document.body.scrollHeight || 0) * 0.5));
        }).catch(function() {});
        await ownPage.waitForTimeout(700);
        await ownPage.screenshot({ path: paxShotAbs });
      } catch (e2) { logger.warn('[REVIEW-ENGINE] passenger screenshot failed: ' + e2.message); }
      // (c) Back to top + hold so the last ~5s of the video show the
      // dialog/banner readable (per the recording requirement).
      await ownPage.evaluate(function() { window.scrollTo(0, 0); }).catch(function() {});
      await ownPage.waitForTimeout(5000);
      if (result && typeof result === 'object') result.recordingDurationMs = Date.now() - recordStartedAt;
    } catch (e) { logger.warn('[REVIEW-ENGINE] screenshot failed: ' + e.message); }
  } catch (e) {
    logger.warn('[REVIEW-ENGINE] swallowed error: ' + e.message);
    result = { sector: tag, error: e.message, verdict: 'REVIEW_BROKEN', severity: 'P2', startedAt: new Date().toISOString() };
    // Best-effort viewport-only screenshot + brief hold so the final frames
    // show the on-screen state at normal scale (same rationale as above).
    if (ownPage) { try { await ownPage.evaluate(function() { window.scrollTo(0, 0); }).catch(function() {}); await ownPage.screenshot({ path: shotAbs }); await ownPage.waitForTimeout(5000); } catch {} }
  } finally {
    if (ownPage)    { try { await ownPage.close();    } catch {} }
    if (ownContext) { try { await ownContext.close(); } catch {} }
    if (ownBrowser) { try { await ownBrowser.close(); } catch {} }
  }
  const recordingRel = await _finalizeRecording(tmpVideoDir, runId);
  if (!result) result = { sector: tag, verdict: 'REVIEW_BROKEN', severity: 'P2', startedAt: new Date().toISOString() };
  result.runId = runId;
  result.screenshotPath = fs.existsSync(shotAbs) ? shotRel : null;
  result.passengerShotPath = fs.existsSync(paxShotAbs) ? paxShotRel : null;
  result.recordingPath  = recordingRel;
  try { _appendDailyReport(result); } catch {}
  logger.info('[REVIEW-ENGINE] ' + tag + ' runId=' + runId + ' verdict=' + (result && result.verdict) + ' durationMs=' + (result && result.durationMs));
  return result;
}

module.exports = { runForFlightIntl, isEnabled, HARD_TIMEOUT_MS };
