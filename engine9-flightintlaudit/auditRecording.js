// auditRecording.js — Self-contained recording + evidence-capture helpers for
// the merged Flight INTL Audit engine (Engine 9).
//
// These are intentionally a standalone copy (not a require of engine8's
// reviewPulseEngine internals) so the protected, zero-fail-tolerance Review
// engine (CEO Directive #1/#6) is never touched or coupled to this new engine.
// The logic mirrors the proven Review-engine capture/recording behaviour:
//   * a virtual cursor overlay so pointer moves + click pulses show in the video
//   * a viewport-only final screenshot + passenger-section screenshot (never
//     fullPage — fullPage resizes the viewport mid-record and "zooms out" the
//     last seconds of the clip, per the 2026-06-17 Review fix)
//   * WebM → MP4 (+faststart) transcode so the dashboard progress bar can seek

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

// Init script injected via context.addInitScript() so EVERY page/navigation in
// the audit (search form → results → itinerary) shows the cursor + click pulse.
function cursorOverlayInit() {
  try {
    if (window.__faCursorInstalled) return;
    window.__faCursorInstalled = true;
    var install = function () {
      if (!document.body) return;
      var dot = document.createElement('div');
      dot.id = '__fa_cursor__';
      dot.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:rgba(255,0,80,0.85);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.4),0 2px 6px rgba(0,0,0,0.35);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:transform 0.06s linear;';
      document.body.appendChild(dot);
      document.addEventListener('mousemove', function (e) {
        dot.style.left = e.clientX + 'px';
        dot.style.top = e.clientY + 'px';
      }, true);
      var pulse = function (e) {
        var ring = document.createElement('div');
        ring.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;width:10px;height:10px;border-radius:50%;border:3px solid rgba(255,0,80,0.85);pointer-events:none;z-index:2147483646;transform:translate(-50%,-50%);transition:all 0.55s ease-out;opacity:1;';
        document.body.appendChild(ring);
        requestAnimationFrame(function () {
          ring.style.width = '70px';
          ring.style.height = '70px';
          ring.style.opacity = '0';
        });
        setTimeout(function () { if (ring.parentNode) ring.parentNode.removeChild(ring); }, 600);
      };
      document.addEventListener('mousedown', pulse, true);
      document.addEventListener('click', pulse, true);
    };
    if (document.body) install();
    else document.addEventListener('DOMContentLoaded', install);
  } catch (e) {}
}

// Capture the two evidence screenshots and hold the recording for ~holdMs so the
// final seconds of the video stay readable. VIEWPORT-ONLY by design.
//   page       Playwright page (on the review/itinerary page)
//   topShotAbs absolute path for the top-of-page viewport screenshot
//   paxShotAbs absolute path for the passenger-section viewport screenshot
//   holdMs     ms to hold the recording at the end (default 5000)
async function captureEvidenceShots(page, opts) {
  opts = opts || {};
  const holdMs = typeof opts.holdMs === 'number' ? opts.holdMs : 5000;
  try {
    // (a) Readable top-of-page viewport shot — also the video's final frame.
    await page.evaluate(function () { window.scrollTo(0, 0); }).catch(function () {});
    if (opts.topShotAbs) await page.screenshot({ path: opts.topShotAbs });
    // (b) Passenger/Traveller-section viewport shot — the region FAILED_TO_LOAD /
    // REVIEW_BROKEN is about, so the report can tell a real Etrav failure apart
    // from an EQIS detection miss.
    if (opts.paxShotAbs) {
      try {
        await page.evaluate(function () {
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
        }).catch(function () {});
        await page.waitForTimeout(700);
        await page.screenshot({ path: opts.paxShotAbs });
      } catch (e2) { logger.warn('[FLIGHT-INTL-AUDIT] passenger screenshot failed: ' + e2.message); }
    }
    // (c) Back to top + hold so the last ~holdMs of the clip are readable.
    await page.evaluate(function () { window.scrollTo(0, 0); }).catch(function () {});
    if (holdMs > 0) await page.waitForTimeout(holdMs);
  } catch (e) {
    logger.warn('[FLIGHT-INTL-AUDIT] evidence capture failed: ' + e.message);
  }
}

// After the context closes, Playwright finalises the .webm into tmpDir. Pick it
// up and transcode → MP4 (+faststart) keyed by runId under recsDir.
//   tmpDir   the per-run recordVideo dir
//   runId    unique run id
//   recsDir  destination recordings dir
//   relBase  base dir the returned relative path is computed against
// Returns a path relative to relBase (e.g. 'recordings/audit-REV-x.mp4') or null.
function finalizeRecording(tmpDir, runId, recsDir, relBase) {
  try {
    if (!fs.existsSync(tmpDir)) return null;
    const files = fs.readdirSync(tmpDir).filter(function (f) { return /\.webm$/i.test(f); });
    if (!files.length) return null;
    ensureDir(recsDir);
    const src = path.join(tmpDir, files[0]);
    const mp4Dst = path.join(recsDir, 'audit-' + runId + '.mp4');
    const rel = function (abs) { return path.relative(relBase, abs); };
    try {
      execSync(
        'ffmpeg -y -i "' + src + '" -c:v libx264 -preset veryfast -crf 28 ' +
        '-movflags +faststart -pix_fmt yuv420p -an "' + mp4Dst + '"',
        { stdio: 'pipe', timeout: 60000 }
      );
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return rel(mp4Dst);
    } catch (ffErr) {
      logger.warn('[FLIGHT-INTL-AUDIT] ffmpeg transcode failed, keeping .webm: ' + (ffErr && ffErr.message ? ffErr.message.split('\n')[0] : 'unknown'));
      const webmDst = path.join(recsDir, 'audit-' + runId + '.webm');
      try { fs.renameSync(src, webmDst); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return fs.existsSync(webmDst) ? rel(webmDst) : null;
    }
  } catch (e) {
    logger.warn('[FLIGHT-INTL-AUDIT] finalize recording failed: ' + e.message);
    return null;
  }
}

module.exports = { cursorOverlayInit, captureEvidenceShots, finalizeRecording, ensureDir };
