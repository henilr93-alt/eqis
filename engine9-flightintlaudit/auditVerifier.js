// FRAKA Audit Verifier — Engine 9 (Flight INTL Audit) post-run video-vs-data check.
//
// After every Flight INTL Audit run that books a flight, FRAKA extracts the last
// frames of the recording + the evidence screenshots and uses Claude vision to
// confirm that what the VIDEO shows matches the DATA the engine recorded:
//   (1) Booked flight matches the recorded target (airline + flight code).
//   (2) Passenger count on the itinerary matches the recorded paxCount.
//   (3) Fare & price shown match the recorded fare/price.
//   (4) The recorded verdict is justified by what the video actually shows.
//
// If the video proves an EQIS-side flow is broken (the engine recorded data that
// the video contradicts), FRAKA files a CEO-queue proposal + a development entry
// and logs loudly — but it does NOT auto-fix. A human approves before any change
// ships (user policy: "Diagnose + propose fix, gate on approval").
//
// Self-contained & ADDITIVE: lives in engine9-flightintlaudit/, owns its own state
// file, imports only proposalsStore/developmentsStore. Does not modify or import any
// engine3/engine8 logic. Gated OFF by default behind FLIGHT_INTL_AUDIT_VERIFY_ENABLED.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const proposalsStore = require('../fraka/proposalsStore');
const developmentsStore = require('../fraka/developmentsStore');

// Assets are stored RELATIVE to REPORTS_DIR by the engine (_buildRow), so resolve
// the same way the engine does.
const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'flight-intl-audit');
const STATE_PATH = path.join(__dirname, '..', 'state', 'flightIntlAuditVerifications.json');
const TMP_FRAME_DIR = '/tmp/eqis-fia-verify-frames';

const VIDEO_FRAME_COUNT = 3;   // last N seconds of video, one frame each
const MISMATCH_COOLDOWN_MS = 30 * 60 * 1000; // 30 min de-dupe per affectedFile+check

// Proposal/development de-dupe: skip filing the same mismatch more than once per
// cooldown. Key = affectedFile + primary failing check. Value = last-filed ts.
const _recentMismatches = new Map();

// EQIS-side automation statuses that abort the run BEFORE a flight is booked (so the
// SUCCESS video-vs-data verify can never run), but are still OUR bug to fix — not
// Etrav's. The escalator skips these (not Etrav-side) and the general failureAuditor
// never ingests Engine-9 runs, so without this branch they route NOWHERE. We file a
// CEO-queue proposal + dev so a human can fix the responsible automation file. No auto-fix.
const EQIS_AUTOMATION_BREAK_STATUSES = new Set(['AUTOMATION_DATE_INCOMPLETE', 'AUTOMATION_FORM_RESET']);
const AUTOMATION_BREAK_COOLDOWN_MS = 30 * 60 * 1000;
const _recentAutomationBreaks = new Map();

const VERIFY_SYSTEM_PROMPT = `You are FRAKA's Flight INTL Audit verifier. You receive evidence (itinerary/review-page screenshot, a passenger-area screenshot, and the final frames of a screen recording) from one automated end-to-end run on Etrav (a B2B travel platform). The run did: search flights -> pick a fare -> click Book -> land on the review/itinerary page. EQIS recorded structured DATA about what it believes it booked. Your job is to confirm the VIDEO/SCREENSHOTS match that DATA, and decide if any EQIS automation flow is broken.

You will be given the RECORDED DATA (what EQIS claims) and must verify it against the VISUAL evidence.

Check these four things independently:
  (1) FLIGHT MATCH — Does the booked flight shown on the itinerary (airline + flight number/code) match the recorded target flight code? Multi-leg/round-trip may show an onward + return flight.
  (2) PAX MATCH — Does the passenger count shown (adults/children/infants in the Fare Summary or Traveller section) match the recorded paxCount?
  (3) FARE & PRICE — Is the SAME flight + fare class shown on the itinerary as what EQIS recorded? NOTE: the recorded "price" is the RESULTS-LISTING per-fare price shown on the flight row at selection time (typically a single/base-fare figure), NOT the itinerary's all-passenger grand total. Do NOT compare it numerically against the itinerary's multi-passenger total. Only judge fare/price consistency by whether the itinerary prices the SAME flight and fare family that EQIS recorded.
  (4) VERDICT JUSTIFIED — Given what the video/screenshots actually show, is the recorded verdict (e.g. REVIEW_OK, FAILED_TO_LOAD, SOLD_OUT) justified?

IMPORTANT GUARDS (do NOT flag these as broken flows):
  - Etrav frequently RENAMES the fare label between the results listing and the itinerary page (e.g. "Economy Standard" -> "Economy Flexi (NDC)", "Package" -> "Special"). A differing fare LABEL is Etrav's own labelling, NOT an EQIS flow break, as long as it is the same booked flight at a consistent price. Treat fare-label-only differences as "pass".
  - An internal flight-code field that looks mis-extracted from baggage text (e.g. "KG1" from "25 KG 1 PC") is a cosmetic field issue, NOT a booking flow break, if the correct flight is visibly booked. Note it in evidence but keep verdictJustified "pass".
  - PRICE-BASIS GUARD: The recorded target price is a PER-FARE LISTING price (one row's fare figure), while the itinerary shows the FULL multi-passenger grand total (base fares × pax + taxes + fees). A larger itinerary total than the recorded listing price is EXPECTED for any multi-passenger booking and is NOT a discrepancy. NEVER set fareMatch="fail" or flag an EQIS flow break merely because the itinerary total is higher than the recorded listing price. Only mark fareMatch="fail" if the itinerary clearly prices a DIFFERENT flight/fare than recorded, or the math is internally impossible (e.g. itinerary total is LOWER than a single base fare it itself lists).
  - Etrav-side errors (page failed to load, sold out, price changed, session expired, banner errors) are NOT EQIS flow breaks — set side="etrav".

An EQIS FLOW BREAK (side="eqis") means: EQIS booked or recorded the WRONG thing vs. what the video shows — e.g. it claims it booked flight X but the itinerary shows flight Y (selection drift), it recorded the wrong pax count, it recorded REVIEW_OK but the video shows an error page, or it never actually reached the itinerary yet claims success.

Respond ONLY with valid JSON:
{
  "flightMatch": "pass" | "fail" | "unclear",
  "paxMatch": "pass" | "fail" | "unclear",
  "fareMatch": "pass" | "fail" | "unclear",
  "verdictJustified": "pass" | "fail" | "unclear",
  "overallVerdict": "MATCH" | "MISMATCH" | "UNCLEAR",
  "side": "eqis" | "etrav" | "unclear",
  "brokenFlow": "<if eqis-side: short name of the broken flow, e.g. 'selection-drift', 'pax-mismatch', 'false-success'. Empty otherwise.>",
  "affectedFile": "<if eqis-side: best-guess source file, e.g. 'engine8-reviewpulse/flightIntlReviewPulse.js' or 'engine9-flightintlaudit/flightIntlAuditEngine.js'. Empty otherwise.>",
  "rootCause": "<one short sentence describing what you observed>",
  "evidence": "<what you saw in the screenshots/frames that supports the verdict>",
  "fixSuggestion": "<if eqis-side: a short technical fix suggestion. Empty otherwise.>"
}`;

function isEnabled() {
  return String(process.env.FLIGHT_INTL_AUDIT_VERIFY_ENABLED || 'false').toLowerCase() === 'true';
}

function safeRead(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function safeWrite(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch (e) {
    logger.warn('[FIA-VERIFY] state write failed: ' + e.message);
  }
}
function loadState() {
  const s = safeRead(STATE_PATH, null);
  if (!s || typeof s !== 'object') return { version: 1, verifications: [], lastVerifiedAt: null, totalVerified: 0 };
  if (!Array.isArray(s.verifications)) s.verifications = [];
  return s;
}

// Resolve a report-relative asset path to an absolute path on disk.
function _resolveAsset(rel) {
  if (!rel) return null;
  const abs = path.isAbsolute(rel) ? rel : path.join(REPORTS_DIR, rel);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * Extract N frames from the END of a video (the itinerary hold at run-end).
 * Returns an array of absolute paths to extracted PNGs.
 */
function extractVideoFrames(videoAbs, count = VIDEO_FRAME_COUNT) {
  if (!videoAbs || !fs.existsSync(videoAbs)) return [];
  if (!fs.existsSync(TMP_FRAME_DIR)) fs.mkdirSync(TMP_FRAME_DIR, { recursive: true });
  const stem = 'fiav-' + path.basename(videoAbs).replace(/\.[^.]+$/, '') + '-' + Date.now();
  const paths = [];
  for (let i = 0; i < count; i++) {
    const sseof = -(i * 2 + 1); // -1s, -3s, -5s from end
    const out = path.join(TMP_FRAME_DIR, stem + '-' + i + '.png');
    try {
      execFileSync('ffmpeg', [
        '-y', '-sseof', String(sseof), '-i', videoAbs, '-frames:v', '1',
        '-q:v', '4', out,
      ], { stdio: 'pipe', timeout: 15000 });
      if (fs.existsSync(out) && fs.statSync(out).size > 0) paths.push(out);
    } catch {
      // ffmpeg failed for this frame — skip silently
    }
  }
  return paths;
}

function readImageAsBase64(p) {
  if (!p || !fs.existsSync(p)) return null;
  try { return fs.readFileSync(p).toString('base64'); } catch { return null; }
}

// Build a human-readable summary of a target object for the prompt.
function _describeTarget(t) {
  if (!t || typeof t !== 'object') return '(none)';
  const parts = [];
  if (t.airline) parts.push(t.airline);
  if (t.flightCode) parts.push(t.flightCode);
  if (t.fareLabel) parts.push('[' + t.fareLabel + ']');
  if (t.price != null && t.price !== '') parts.push('₹' + t.price);
  return parts.join(' ') || '(none)';
}

/**
 * Verify a single completed audit run against its video + screenshots.
 * @param {Object} row - the unified audit row written by flightIntlAuditEngine._buildRow
 * @returns {Object} { verified:boolean, reason?:string, verdict?:Object }
 */
async function verifyRun({ row } = {}) {
  if (!isEnabled()) return { verified: false, reason: 'disabled' };
  if (!row || typeof row !== 'object') return { verified: false, reason: 'no_row' };

  const search = row.search || {};
  const review = row.review || {};
  const target = review.target || row.target || null;

  // Scope gate: only verify runs that actually searched, booked a flight, and have a
  // recording to inspect. Search-failed / review-SKIPPED runs have nothing to compare.
  if (search.status !== 'SUCCESS') {
    // EQIS-side automation breaks (e.g. round-trip date picker aborted before booking)
    // route NOWHERE else — the escalator filters them as not-Etrav-side and the general
    // failureAuditor never ingests Engine-9 runs. File a CEO-queue proposal + dev here.
    if (EQIS_AUTOMATION_BREAK_STATUSES.has(search.status)) {
      return _persistAutomationBreak(row, search);
    }
    // Genuinely Etrav-side / other non-success statuses stay out of scope (the CMT
    // escalator owns the Etrav-side ones).
    return { verified: false, reason: 'search_not_success' };
  }
  if (!target) return { verified: false, reason: 'no_target_booked' };
  const recAbs = _resolveAsset(row.recordingPath);
  if (!recAbs) return { verified: false, reason: 'no_recording' };

  const shotAbs = _resolveAsset(row.screenshotPath);
  const paxShotAbs = _resolveAsset(row.passengerShotPath);

  const shotB64 = readImageAsBase64(shotAbs);
  const paxB64 = readImageAsBase64(paxShotAbs);
  const framePaths = extractVideoFrames(recAbs);
  const frameB64 = framePaths.map(readImageAsBase64).filter(Boolean);

  if (!shotB64 && !paxB64 && frameB64.length === 0) {
    for (const fp of framePaths) { try { fs.unlinkSync(fp); } catch {} }
    return { verified: false, reason: 'no_visual_evidence' };
  }

  const userText = [
    'A Flight INTL Audit run completed. Verify the recorded DATA against the visual evidence.',
    '',
    'RECORDED DATA (what EQIS claims it did):',
    '- Run ID: ' + (row.runId || ''),
    '- Sector: ' + (row.sector || ''),
    '- Trip type: ' + (row.tripType || ''),
    '- Cabin class: ' + (row.cabinClass || ''),
    '- Passenger count (recorded): ' + (row.paxCount || '(none)'),
    '- Search status: ' + (search.status || ''),
    '- Results found: ' + (search.resultCount || 0),
    '- Recorded verdict: ' + (review.verdict || row.verdict || ''),
    '- Recorded booked flight (target): ' + _describeTarget(target),
    (target && target.returnFlightCode ? '- Recorded return flight: ' + (target.returnAirline || '') + ' ' + target.returnFlightCode : ''),
    '',
    'VISUAL EVIDENCE provided (in order): ' +
      (shotB64 ? 'itinerary screenshot, ' : '') +
      (paxB64 ? 'passenger-area screenshot, ' : '') +
      frameB64.length + ' final video frame(s) (latest first).',
    '',
    'Confirm flight match, pax match, fare/price, and whether the verdict is justified. Apply the fare-label and Etrav-side guards. Respond with the JSON only.',
  ].filter(Boolean).join('\n');

  // Order: itinerary shot (most relevant), passenger shot, then end-of-video frames.
  const images = [];
  if (shotB64) images.push(shotB64);
  if (paxB64) images.push(paxB64);
  for (const f of frameB64) images.push(f);

  let verdict = null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const content = [{ type: 'text', text: userText }];
    for (const b64 of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
    }
    const resp = await client.messages.create({
      model: settings.FRAKA_ANALYSIS_MODEL || 'claude-sonnet-4-6',
      max_tokens: 900,
      system: VERIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });
    const text = (resp.content || []).map(c => c.text || '').join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (m) verdict = JSON.parse(m[0]);
  } catch (err) {
    logger.warn('[FIA-VERIFY] Claude vision call failed: ' + err.message);
  }

  // Cleanup temp frames
  for (const fp of framePaths) { try { fs.unlinkSync(fp); } catch {} }

  if (!verdict) {
    verdict = {
      flightMatch: 'unclear', paxMatch: 'unclear', fareMatch: 'unclear', verdictJustified: 'unclear',
      overallVerdict: 'UNCLEAR', side: 'unclear', brokenFlow: '', affectedFile: '',
      rootCause: 'Claude vision analysis failed or returned unparseable output', evidence: '', fixSuggestion: '',
    };
  }
  verdict.framesAnalyzed = frameB64.length;
  verdict.usedScreenshot = !!shotB64;
  verdict.usedPassengerShot = !!paxB64;

  _persistVerification(row, verdict);
  return { verified: true, verdict };
}

/**
 * Persist the verification + (if an EQIS flow break is proven) file a CEO-queue
 * proposal and a development entry. NEVER auto-approves or auto-builds.
 */
function _persistVerification(row, verdict) {
  const state = loadState();
  const entry = {
    runId: row.runId,
    sector: row.sector || '',
    tripType: row.tripType || '',
    paxCount: row.paxCount || '',
    recordedVerdict: (row.review && row.review.verdict) || row.verdict || '',
    recordedTarget: _describeTarget((row.review && row.review.target) || row.target),
    flightMatch: verdict.flightMatch,
    paxMatch: verdict.paxMatch,
    fareMatch: verdict.fareMatch,
    verdictJustified: verdict.verdictJustified,
    overallVerdict: verdict.overallVerdict,
    side: verdict.side,
    brokenFlow: verdict.brokenFlow || '',
    affectedFile: verdict.affectedFile || '',
    rootCause: verdict.rootCause || '',
    evidence: verdict.evidence || '',
    fixSuggestion: verdict.fixSuggestion || '',
    framesAnalyzed: verdict.framesAnalyzed || 0,
    usedScreenshot: !!verdict.usedScreenshot,
    usedPassengerShot: !!verdict.usedPassengerShot,
    proposalId: null,
    developmentId: null,
    verifiedAt: new Date().toISOString(),
  };

  const isEqisBreak = verdict.overallVerdict === 'MISMATCH' && verdict.side === 'eqis';

  if (isEqisBreak) {
    // Loud log — this is the headline the user wants surfaced.
    logger.error('[FIA-VERIFY] 🚨 EQIS FLOW BROKEN — run ' + row.runId + ' (' + (row.sector || '') +
      ') brokenFlow=' + (verdict.brokenFlow || '?') + ' file=' + (verdict.affectedFile || '?') +
      ' — ' + (verdict.rootCause || ''));

    // De-dupe so the same broken file+flow doesn't spawn a proposal every run.
    const primaryCheck = verdict.flightMatch === 'fail' ? 'flight'
      : verdict.paxMatch === 'fail' ? 'pax'
      : verdict.verdictJustified === 'fail' ? 'verdict'
      : verdict.fareMatch === 'fail' ? 'fare' : 'other';
    const dedupeKey = (verdict.affectedFile || 'unknown') + '::' + primaryCheck;
    const now = Date.now();
    const last = _recentMismatches.get(dedupeKey);
    const onCooldown = last && (now - last) < MISMATCH_COOLDOWN_MS;

    if (!onCooldown) {
      _recentMismatches.set(dedupeKey, now);
      // CEO-queue proposal (user chose "CEO queue"). Gated on human approval —
      // status starts 'pending', and we DO NOT auto-approve or run a build.
      try {
        const prop = proposalsStore.createProposal({
          type: 'code-fix',
          audience: 'ceo',
          description: 'FIA VIDEO AUDIT (' + row.runId + ', ' + (row.sector || '') + '): EQIS flow broken — ' +
            (verdict.brokenFlow || 'mismatch') + '. ' + (verdict.rootCause || '') +
            ' Suggested fix: ' + (verdict.fixSuggestion || 'n/a') +
            ' Affected file: ' + (verdict.affectedFile || 'unknown') + '.',
          details: {
            runId: row.runId,
            sector: row.sector || '',
            checks: {
              flightMatch: verdict.flightMatch, paxMatch: verdict.paxMatch,
              fareMatch: verdict.fareMatch, verdictJustified: verdict.verdictJustified,
            },
            affectedFile: verdict.affectedFile || '',
            recordedVerdict: entry.recordedVerdict,
            recordedTarget: entry.recordedTarget,
          },
          reasoning: 'Video-vs-data audit found the recording contradicts the recorded data. ' + (verdict.evidence || ''),
          estimatedCostImpactUsd: 0,
        }, 'fraka-fia-verifier');
        if (prop && prop.id) entry.proposalId = prop.id;
      } catch (err) {
        logger.warn('[FIA-VERIFY] proposal create failed: ' + err.message);
      }

      // Development backlog entry (deduped by fingerprint inside the store).
      try {
        const dev = developmentsStore.upsertDevelopment({
          category: 'Engine Reliability',
          subcategory: 'Flight INTL Audit',
          title: 'EQIS flow break: ' + (verdict.brokenFlow || 'video/data mismatch') +
            ' in ' + (verdict.affectedFile || 'unknown'),
          description: (verdict.rootCause || '') + ' (first seen run ' + row.runId + ', ' + (row.sector || '') + ').',
          customerBenefit: 'Ensures Flight INTL Audit books and reports the correct flight/pax/fare.',
          evidence: verdict.evidence || '',
          priority: 'HIGH',
          effort: 'M',
        }, 'fraka-fia-verifier');
        if (dev && dev.id) entry.developmentId = dev.id;
      } catch (err) {
        logger.warn('[FIA-VERIFY] development upsert failed: ' + err.message);
      }
    } else {
      logger.info('[FIA-VERIFY] mismatch proposal SKIPPED (cooldown) key=' + dedupeKey);
    }
  } else {
    logger.info('[FIA-VERIFY] ' + row.runId + ' → ' + verdict.overallVerdict + ' [' + verdict.side + '] ' +
      '(flight=' + verdict.flightMatch + ' pax=' + verdict.paxMatch + ' fare=' + verdict.fareMatch +
      ' verdict=' + verdict.verdictJustified + ')');
  }

  state.verifications.push(entry);
  if (state.verifications.length > 500) state.verifications = state.verifications.slice(-500);
  state.lastVerifiedAt = new Date().toISOString();
  state.totalVerified = (state.totalVerified || 0) + 1;
  safeWrite(STATE_PATH, state);
}

/**
 * Route an EQIS-side automation break (search aborted BEFORE a flight could be
 * booked — e.g. the round-trip date picker failed all retries). Files a CEO-queue
 * proposal + a development entry (deduped, 30-min cooldown) so a human can fix the
 * responsible automation file. NEVER auto-fixes. Returns a verifyRun-shaped result.
 */
function _persistAutomationBreak(row, search) {
  const status = search.status;
  const rootCause = search.failureReason || search.failureDetail ||
    ('Search aborted with ' + status + ' before a flight could be booked.');
  const affectedFile = 'utils/etravFormHelpers.js';
  const brokenFlow = 'roundtrip-date-commit';

  logger.error('[FIA-VERIFY] 🚨 EQIS AUTOMATION BREAK — run ' + row.runId + ' (' + (row.sector || '') +
    ') status=' + status + ' file=' + affectedFile + ' — ' + rootCause);

  const dedupeKey = affectedFile + '::' + status;
  const now = Date.now();
  const last = _recentAutomationBreaks.get(dedupeKey);
  const onCooldown = last && (now - last) < AUTOMATION_BREAK_COOLDOWN_MS;

  let proposalId = null;
  let developmentId = null;

  if (!onCooldown) {
    _recentAutomationBreaks.set(dedupeKey, now);
    // CEO-queue proposal — gated on human approval (status starts 'pending'). No auto-build.
    try {
      const prop = proposalsStore.createProposal({
        type: 'code-fix',
        audience: 'ceo',
        description: 'FIA AUTOMATION BREAK (' + row.runId + ', ' + (row.sector || '') + '): ' + status +
          ' — search aborted before booking. ' + rootCause +
          ' Affected file: ' + affectedFile + ' (pickFlightDateRange).',
        details: {
          runId: row.runId,
          sector: row.sector || '',
          searchStatus: status,
          tripType: row.tripType || '',
          affectedFile,
          brokenFlow,
          failureReason: search.failureReason || '',
        },
        reasoning: 'Engine-9 round-trip date automation failed to commit a valid date, so the run never ' +
          'booked. This EQIS-side break is invisible to the CMT escalator (not Etrav-side) and to the ' +
          'general failureAuditor (Engine-9 runs are not ingested). Harden the date-commit fallback in ' +
          'pickFlightDateRange.',
        estimatedCostImpactUsd: 0,
      }, 'fraka-fia-verifier');
      if (prop && prop.id) proposalId = prop.id;
    } catch (err) {
      logger.warn('[FIA-VERIFY] automation-break proposal create failed: ' + err.message);
    }

    // Development backlog entry (deduped by fingerprint inside the store).
    try {
      const dev = developmentsStore.upsertDevelopment({
        category: 'Engine Reliability',
        subcategory: 'Flight INTL Audit',
        title: 'EQIS automation break: ' + status + ' in ' + affectedFile,
        description: rootCause + ' (first seen run ' + row.runId + ', ' + (row.sector || '') + ').',
        customerBenefit: 'Ensures Flight INTL Audit round-trip searches actually submit and book.',
        evidence: 'Search status ' + status + ' on ' + (row.sector || '') + ' (' + (row.tripType || '') + ').',
        priority: 'HIGH',
        effort: 'M',
      }, 'fraka-fia-verifier');
      if (dev && dev.id) developmentId = dev.id;
    } catch (err) {
      logger.warn('[FIA-VERIFY] automation-break development upsert failed: ' + err.message);
    }
  } else {
    logger.info('[FIA-VERIFY] automation-break proposal SKIPPED (cooldown) key=' + dedupeKey);
  }

  // Record in the same verifications state so it surfaces alongside video-vs-data results.
  const state = loadState();
  state.verifications.push({
    runId: row.runId,
    sector: row.sector || '',
    tripType: row.tripType || '',
    paxCount: row.paxCount || '',
    recordedVerdict: (row.review && row.review.verdict) || row.verdict || '',
    recordedTarget: '(none — aborted before booking)',
    flightMatch: 'n/a',
    paxMatch: 'n/a',
    fareMatch: 'n/a',
    verdictJustified: 'n/a',
    overallVerdict: 'AUTOMATION_BREAK',
    side: 'eqis',
    brokenFlow,
    affectedFile,
    rootCause,
    evidence: '',
    fixSuggestion: 'Harden pickFlightDateRange date-commit fallback (native value-setter tier).',
    framesAnalyzed: 0,
    usedScreenshot: false,
    usedPassengerShot: false,
    proposalId,
    developmentId,
    verifiedAt: new Date().toISOString(),
  });
  if (state.verifications.length > 500) state.verifications = state.verifications.slice(-500);
  state.lastVerifiedAt = new Date().toISOString();
  state.totalVerified = (state.totalVerified || 0) + 1;
  safeWrite(STATE_PATH, state);

  return { verified: true, reason: 'automation_break', automationBreak: true, status, proposalId, developmentId };
}

function listVerifications(filter = {}) {
  let list = loadState().verifications.slice();
  if (filter.runId) list = list.filter(v => v.runId === filter.runId);
  if (filter.side) list = list.filter(v => v.side === filter.side);
  if (filter.overallVerdict) list = list.filter(v => v.overallVerdict === filter.overallVerdict);
  list.reverse(); // newest first
  return list;
}

function getVerification(runId) {
  return loadState().verifications.find(v => v.runId === runId) || null;
}

module.exports = {
  isEnabled,
  verifyRun,
  listVerifications,
  getVerification,
  loadState,
};
