/**
 * Session Recorder — Records ACTUAL search sessions as MP4 videos.
 * 
 * Instead of replaying searches, this creates a recording-enabled page that the
 * ACTUAL search runs inside. The video captures the real form filling, real search
 * submission, and real results loading — so video duration = search duration exactly.
 *
 * Login-once: saves auth cookies from the main browser, reuses for recording contexts.
 */

var fs = require('fs');
var path = require('path');
var { execSync } = require('child_process');
var logger = require('./logger');
var driveStorage = null;
try { driveStorage = require('./driveStorage'); } catch (e) { /* optional */ }

var RECORD_DIR = process.env.RECORDING_DIR || path.join(__dirname, '..', 'reports', 'recordings');
var STATE_PATH = path.join(__dirname, '..', 'state', 'recordingState.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); }
  catch { return { sessionCount: 0, recordedCount: 0 }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function shouldRecord(interval) {
  var state = loadState();
  state.sessionCount++;
  var shouldRec = (state.sessionCount % interval) === 0;
  saveState(state);
  return shouldRec;
}

function convertToMp4(webmPath, mp4Path) {
  try {
    execSync(
      'ffmpeg -y -i "' + webmPath + '" -c:v libx264 -preset fast -crf 28 -movflags +faststart -an "' + mp4Path + '"',
      { stdio: 'pipe', timeout: 120000 }
    );
    try { fs.unlinkSync(webmPath); } catch {}
    var size = fs.statSync(mp4Path).size;
    logger.info('[RECORDER] MP4 created: ' + mp4Path + ' (' + Math.round(size / 1024) + 'KB)');
    return true;
  } catch (err) {
    logger.error('[RECORDER] MP4 conversion failed: ' + err.message);
    return false;
  }
}

/**
 * Create a recording-enabled page inside the existing browser.
 * The caller runs the actual search on this page — the video captures the real search.
 * 
 * @param {Browser} browser - The existing Playwright browser instance
 * @param {Page} mainPage - The main page (used to save auth cookies)
 * @param {string} searchId - Used for the output filename
 * @returns {{ recPage, finalize }} - recPage to run search on, finalize() to stop recording and get MP4 path
 */
async function createRecordingPage(browser, mainPage, searchId, formUrl) {
  // RECORDING_ENABLED=false (Railway/low-memory): no-op stub
  if ((process.env.RECORDING_ENABLED || 'true').toLowerCase() === 'false') {
    return { recPage: null, finalize: async () => null };
  }

  if (!fs.existsSync(RECORD_DIR)) fs.mkdirSync(RECORD_DIR, { recursive: true });
  var videoDir = path.join(RECORD_DIR, 'tmp-' + searchId);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  // Save auth state from the main page's context
  var authPath = path.join(RECORD_DIR, 'tmp-auth-' + searchId + '.json');
  var settings = require('../config/settings');
  await mainPage.context().storageState({ path: authPath });

  // Create a new context with video recording + saved auth (no login needed)
  var recContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-IN',
    timezoneId: settings.TIMEZONE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    storageState: authPath,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  var recPage = await recContext.newPage();
  recPage.setDefaultTimeout(30000);

  // Pre-navigate to the form page so the video starts with the form already visible
  if (formUrl) {
    try {
      await recPage.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await recPage.waitForSelector(
        'input.react-autosuggest__input, input[placeholder="Where From ?"], input[placeholder="Hotel name or Destination"]',
        { timeout: 15000 }
      ).catch(function() {});
      await recPage.waitForTimeout(1500);
      await recPage.evaluate(function() {
        ['.react-responsive-modal-root', '.react-responsive-modal-container',
         '.react-responsive-modal-overlay', '[class*="modal"]', '[class*="popup"]'].forEach(function(sel) {
          document.querySelectorAll(sel).forEach(function(el) {
            if (el.id !== 'root' && el.id !== 'portal-root') el.remove();
          });
        });
        window.scrollTo(0, 0);
      }).catch(function() {});
    } catch (navErr) {
      logger.warn('[RECORDER] Pre-navigation failed: ' + navErr.message);
    }
  }

  logger.info('[RECORDER] Recording started for search ID ' + searchId);

  // Return the page for the caller to run the actual search on,
  // plus a finalize function to stop recording and convert to MP4
  return {
    recPage: recPage,
    finalize: async function(searchStatus) {
      // Outcome prefix for human-readable filenames: success vs failure.
      // Anything that's not strictly SUCCESS is considered a failure for
      // filename purposes (ZERO_RESULTS, AUTOMATION_*, ETRAV_*, FAILED, etc.)
      var outcome = (searchStatus === 'SUCCESS') ? 'success' : 'failure';
      try {
        await recContext.close();
        try { fs.unlinkSync(authPath); } catch {}
        var webmFiles = fs.readdirSync(videoDir).filter(function(f) { return f.endsWith('.webm'); });
        if (webmFiles.length === 0) {
          try { fs.rmSync(videoDir, { recursive: true }); } catch {}
          return null;
        }
        var format = (process.env.RECORDING_FORMAT || 'mp4').toLowerCase();
        var srcWebm = path.join(videoDir, webmFiles[0]);
        if (format === 'webm') {
          // Skip ffmpeg entirely. Modern browsers (Chrome/Edge/Firefox/Safari
          // 14+) play WebM natively. On memory-constrained hosts (Railway
          // 512MB), the ffmpeg WebM->MP4 step previously got OOM-killed.
          var webmOut = path.join(RECORD_DIR, 'session-' + outcome + '-' + searchId + '.webm');
          try {
            fs.renameSync(srcWebm, webmOut);
          } catch (renameErr) {
            // Cross-device rename not allowed when RECORD_DIR is a volume
            // mounted on a different filesystem — fall back to copy + unlink.
            fs.copyFileSync(srcWebm, webmOut);
            try { fs.unlinkSync(srcWebm); } catch {}
          }
          try { fs.rmSync(videoDir, { recursive: true }); } catch {}
          var s = loadState(); s.recordedCount++; saveState(s);
          var size = fs.statSync(webmOut).size;
          logger.info('[RECORDER] WebM saved: ' + webmOut + ' (' + Math.round(size / 1024) + 'KB)');
          // Optional: upload to Google Drive. On success, return the Drive URL
          // and delete the local copy (saves disk on Railway volume).
          if (driveStorage && driveStorage.isEnabled()) {
            try {
              var upload = await driveStorage.uploadRecording(webmOut, 'session-' + outcome + '-' + searchId + '.webm');
              try { fs.unlinkSync(webmOut); } catch {}
              return upload.previewUrl;
            } catch (driveErr) {
              logger.warn('[RECORDER] Drive upload failed, keeping local copy: ' + driveErr.message);
            }
          }
          return webmOut;
        }
        // Default: convert to MP4 via ffmpeg (local dev, has enough RAM)
        var mp4Path = path.join(RECORD_DIR, 'session-' + outcome + '-' + searchId + '.mp4');
        if (convertToMp4(srcWebm, mp4Path)) {
          try { fs.rmSync(videoDir, { recursive: true }); } catch {}
          var s2 = loadState(); s2.recordedCount++; saveState(s2);
          if (driveStorage && driveStorage.isEnabled()) {
            try {
              var uploadMp4 = await driveStorage.uploadRecording(mp4Path, 'session-' + outcome + '-' + searchId + '.mp4');
              try { fs.unlinkSync(mp4Path); } catch {}
              return uploadMp4.previewUrl;
            } catch (driveErr) {
              logger.warn('[RECORDER] Drive upload failed, keeping local copy: ' + driveErr.message);
            }
          }
          return mp4Path;
        }
        try { fs.rmSync(videoDir, { recursive: true }); } catch {}
        return null;
      } catch (err) {
        logger.error('[RECORDER] Finalize failed: ' + err.message);
        try { fs.rmSync(videoDir, { recursive: true }); } catch {}
        try { fs.unlinkSync(authPath); } catch {}
        return null;
      }
    }
  };
}

/**
 * Delete recordings older than maxAgeHours (default 24h). Keeps disk usage
 * bounded — on Railway's 500MB volume at 2-3MB per video, ~24h of serial
 * pulses fits comfortably. Called at pulse start from searchPulseEngine.
 */
function cleanupOldRecordings(maxAgeHours) {
  var cutoff = Date.now() - (maxAgeHours || 24) * 3600 * 1000;
  var deleted = 0;
  try {
    if (!fs.existsSync(RECORD_DIR)) return 0;
    var files = fs.readdirSync(RECORD_DIR);
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!/\.(mp4|webm)$/i.test(f)) continue;
      var fp = path.join(RECORD_DIR, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          deleted++;
        }
      } catch {}
    }
    if (deleted > 0) logger.info('[RECORDER] Cleanup: removed ' + deleted + ' recordings older than ' + (maxAgeHours || 24) + 'h');
  } catch (err) {
    logger.warn('[RECORDER] Cleanup failed: ' + err.message);
  }
  return deleted;
}

module.exports = { shouldRecord, createRecordingPage, cleanupOldRecordings, RECORD_DIR };
