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

var RECORD_DIR = path.join(__dirname, '..', 'reports', 'recordings');
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
    finalize: async function() {
      try {
        await recContext.close();
        // Cleanup auth file
        try { fs.unlinkSync(authPath); } catch {}
        // Convert WebM to MP4
        var webmFiles = fs.readdirSync(videoDir).filter(function(f) { return f.endsWith('.webm'); });
        if (webmFiles.length > 0) {
          var mp4Path = path.join(RECORD_DIR, 'session-' + searchId + '.mp4');
          if (convertToMp4(path.join(videoDir, webmFiles[0]), mp4Path)) {
            try { fs.rmSync(videoDir, { recursive: true }); } catch {}
            var s = loadState(); s.recordedCount++; saveState(s);
            return mp4Path;
          }
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

module.exports = { shouldRecord, createRecordingPage, RECORD_DIR };
