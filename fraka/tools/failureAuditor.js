// FRAKA Failure Auditor — analyzes every FAILURE/SPF rated search across all 4
// SearchPulse engines using vision analysis on the screenshot + video frames.
// Decides: was this an Etrav-side issue or an EQIS-side automation bug?
//
// If EQIS-side, the auditor:
//   1. Records the pattern in the persistent rule book
//   2. Generates a fix proposal in the proposals store (for tech review)
//   3. Marks the finding as "automation-bug" so the dashboard can highlight it
//
// If Etrav-side, the finding is recorded for trend tracking and CMT escalation.
//
// Runs as a scheduled FRAKA task (default every 15 min). Each run only audits
// failures that haven't been audited yet (tracked by searchId in findings file).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const logger = require('../../utils/logger');
const settings = require('../../config/settings');
const { callClaude } = require('../../utils/tokenOptimizer');
const proposalsStore = require('../proposalsStore');

const STATE_DIR = path.join(__dirname, '..', '..', 'state', 'fraka');
const RULE_BOOK_PATH = path.join(STATE_DIR, 'ruleBook.json');
const FINDINGS_PATH = path.join(STATE_DIR, 'auditFindings.json');
const METRICS_PATH = path.join(__dirname, '..', '..', 'state', 'metricsHistory.json');
const TMP_FRAME_DIR = '/tmp/eqis-audit-frames';

// Status values that are considered "failures" worth auditing.
const FAILURE_STATUSES = new Set([
  'FAILED', 'SPF', 'CRITICAL',
  'AUTOMATION_FORM_RESET', 'ETRAV_FORM_CRASH',
  'AUTOSUGGEST_DOWN', 'API_ERROR', 'ZERO_RESULTS',
]);
const FAILURE_RATINGS = new Set(['SPF', 'FAILURE!!!', 'CRITICAL']);

// Hard caps to keep token cost predictable per run.
const MAX_AUDITS_PER_RUN = 5;
const VIDEO_FRAME_COUNT = 3; // last N seconds of video, one frame each

const AUDIT_SYSTEM_PROMPT = `You are FRAKA's failure auditor. You receive screenshots and video frames from a failed automated search on Etrav (a B2B travel platform). Your job is to decide whether the failure was caused by:

  (A) ETRAV-side issue — Etrav's frontend/backend is broken, slow, returned an error page, autosuggest API returned no suggestions, etc. This is a real platform bug agents would also see.
  (B) EQIS-side issue — Our automation made a mistake (clicked the wrong place, cleared a field, didn't wait long enough, mis-handled a calendar/dropdown). The platform was actually fine.
  (C) UNCLEAR — Cannot tell from the available evidence.

You MUST observe the video frames minutely. Look for:
- Did the form ever show the destination/origin filled correctly, then suddenly empty?
- Did Etrav render its "Oops! Something went wrong" page?
- Did a calendar or dropdown stay open, blocking the search button?
- Did the autosuggest list appear with options, or did it stay empty?
- Did our automation click somewhere unexpected (outside the intended element)?

Respond ONLY with valid JSON:
{
  "side": "etrav" | "eqis" | "unclear",
  "confidence": "high" | "medium" | "low",
  "rootCause": "<one short sentence describing what you observed>",
  "evidence": "<what you saw in the frames/screenshot that supports the verdict>",
  "ruleBookEntry": "<a short reusable rule like 'IF page shows Oops illustration AND form inputs missing → ETRAV_FORM_CRASH (etrav-side)'. Empty string if no new rule needed.>",
  "eqisFixSuggestion": "<if side is eqis: a short technical suggestion like 'Add 1500ms wait after pax dropdown closes before reading destination field' OR 'Replace force-click with mouse coordinate click for date picker'. Empty string if etrav-side.>",
  "affectedFile": "<best guess at which source file should change, e.g. 'utils/etravFormHelpers.js' or 'engine3-searchpulse/flightSearchPulse.js'. Empty string if etrav-side.>"
}`;

function safeRead(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function safeWrite(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function loadRuleBook() {
  return safeRead(RULE_BOOK_PATH, { version: 1, rules: [], lastUpdated: null });
}
function loadFindings() {
  return safeRead(FINDINGS_PATH, { version: 1, findings: [], lastAuditAt: null, totalAudited: 0 });
}

/**
 * List failure searches that haven't been audited yet.
 * Looks across all SearchPulse engines (flight + hotel) for the configured time window.
 */
function listUnauditedFailures(hoursBack = 6) {
  const history = safeRead(METRICS_PATH, []);
  const findings = loadFindings();
  const auditedIds = new Set(findings.findings.map(f => String(f.searchId)));
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;

  const failures = [];
  for (const entry of history) {
    if (entry.engineType !== 'searchpulse') continue;
    const ts = new Date(entry.timestamp).getTime();
    if (isNaN(ts) || ts < cutoff) continue;

    const allSearches = [
      ...(entry.flightSearches || []).map(s => ({ ...s, kind: 'flight' })),
      ...(entry.hotelSearches || []).map(s => ({ ...s, kind: 'hotel' })),
    ];
    for (const s of allSearches) {
      if (auditedIds.has(String(s.searchId))) continue;
      const isFailure = FAILURE_STATUSES.has(s.status) || FAILURE_RATINGS.has(s.rating);
      if (!isFailure) continue;
      failures.push({
        ...s,
        pulseTimestamp: entry.timestamp,
        pulseId: entry.pulseId || null,
      });
    }
  }
  return failures;
}

/**
 * Extract N evenly-spaced frames from the END of a video (the most-failure-relevant moment).
 * Returns an array of absolute paths to extracted PNGs.
 */
function extractVideoFrames(videoPath, count = VIDEO_FRAME_COUNT) {
  if (!videoPath || !fs.existsSync(videoPath)) return [];
  if (!fs.existsSync(TMP_FRAME_DIR)) fs.mkdirSync(TMP_FRAME_DIR, { recursive: true });
  const stem = 'audit-' + path.basename(videoPath).replace(/\.[^.]+$/, '') + '-' + Date.now();
  const paths = [];
  for (let i = 0; i < count; i++) {
    // Pull frames at -1s, -3s, -5s from the end. ffmpeg -sseof works for this.
    const sseof = -(i * 2 + 1); // -1, -3, -5
    const out = path.join(TMP_FRAME_DIR, stem + '-' + i + '.png');
    try {
      execFileSync('ffmpeg', [
        '-y', '-sseof', String(sseof), '-i', videoPath, '-frames:v', '1',
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

/**
 * Audit a single failure search using vision analysis. Returns the parsed verdict.
 */
async function auditOneSearch(search) {
  const screenshotB64 = readImageAsBase64(search.screenshotPath);
  const framePaths = extractVideoFrames(search.recordingPath);
  const frameB64 = framePaths.map(readImageAsBase64).filter(Boolean);

  if (!screenshotB64 && frameB64.length === 0) {
    return {
      side: 'unclear',
      confidence: 'low',
      rootCause: 'No screenshot or video frames available for analysis',
      evidence: 'Both screenshotPath and recordingPath were missing or unreadable',
      ruleBookEntry: '',
      eqisFixSuggestion: '',
      affectedFile: '',
      hadVisualEvidence: false,
    };
  }

  const userText = [
    'A SearchPulse ' + search.kind + ' search was rated as a failure.',
    '',
    'Search context:',
    '- Search ID: ' + search.searchId,
    '- Engine: ' + (search.kind === 'flight' ? 'Flight' : 'Hotel') + ' ' + (search.type || ''),
    '- Label: ' + (search.label || ''),
    '- Sector/Destination: ' + (search.sector || search.destination || ''),
    '- Status: ' + search.status,
    '- Rating: ' + search.rating,
    '- Failure reason recorded: ' + (search.failureReason || '(none)'),
    '- URL: ' + (search.url || '(none)'),
    '- Pax: ' + (search.paxCount || ''),
    '- Date: ' + (search.searchDate || ''),
    '',
    'You will see ' + (screenshotB64 ? 1 : 0) + ' result screenshot(s) and ' + frameB64.length + ' final video frame(s) (latest first).',
    'Decide whether this was Etrav-side or EQIS-side, and propose a rule + fix.',
  ].join('\n');

  // Build the multi-image input: screenshot first (most relevant), then video frames
  const images = [];
  if (screenshotB64) images.push(screenshotB64);
  for (const f of frameB64) images.push(f);

  // tokenOptimizer.callClaude only takes a single imageBase64 — chain via plain Anthropic call.
  // Use Sonnet for accurate vision reasoning.
  let verdict;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const content = [{ type: 'text', text: userText }];
    for (const b64 of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: b64 },
      });
    }
    const resp = await client.messages.create({
      model: settings.FRAKA_ANALYSIS_MODEL || 'claude-sonnet-4-6',
      max_tokens: 800,
      system: AUDIT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });
    const text = (resp.content || []).map(c => c.text || '').join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (m) verdict = JSON.parse(m[0]);
  } catch (err) {
    logger.warn('[FRAKA-AUDIT] Claude vision call failed: ' + err.message);
  }

  if (!verdict) {
    verdict = {
      side: 'unclear',
      confidence: 'low',
      rootCause: 'Claude vision analysis failed or returned unparseable output',
      evidence: '',
      ruleBookEntry: '',
      eqisFixSuggestion: '',
      affectedFile: '',
    };
  }
  verdict.hadVisualEvidence = (screenshotB64 || frameB64.length > 0);
  verdict.framesAnalyzed = frameB64.length;
  verdict.usedScreenshot = !!screenshotB64;

  // Cleanup temp frames
  for (const fp of framePaths) { try { fs.unlinkSync(fp); } catch {} }

  return verdict;
}

/**
 * Append a finding + (optionally) a new rule + (optionally) a code-fix proposal.
 */
function persistFinding(search, verdict) {
  const findings = loadFindings();
  findings.findings.push({
    searchId: search.searchId,
    engine: search.kind + '-' + (search.type || 'unknown'),
    label: search.label || '',
    sector: search.sector || search.destination || '',
    status: search.status,
    rating: search.rating,
    pulseTimestamp: search.pulseTimestamp,
    side: verdict.side,
    confidence: verdict.confidence,
    rootCause: verdict.rootCause,
    evidence: verdict.evidence,
    ruleBookEntry: verdict.ruleBookEntry || '',
    eqisFixSuggestion: verdict.eqisFixSuggestion || '',
    affectedFile: verdict.affectedFile || '',
    framesAnalyzed: verdict.framesAnalyzed || 0,
    usedScreenshot: verdict.usedScreenshot || false,
    auditedAt: new Date().toISOString(),
  });
  findings.lastAuditAt = new Date().toISOString();
  findings.totalAudited = findings.findings.length;
  safeWrite(FINDINGS_PATH, findings);

  // Add a new rule if Claude suggested one and it's not a near-duplicate
  if (verdict.ruleBookEntry && verdict.ruleBookEntry.trim().length > 10) {
    const rb = loadRuleBook();
    const dup = rb.rules.find(r => r.pattern.toLowerCase() === verdict.ruleBookEntry.toLowerCase().trim());
    if (!dup) {
      rb.rules.push({
        id: 'RULE-' + Date.now() + '-' + Math.floor(Math.random() * 999),
        pattern: verdict.ruleBookEntry.trim(),
        side: verdict.side,
        learnedFromSearchId: search.searchId,
        confidence: verdict.confidence,
        addedAt: new Date().toISOString(),
        timesObserved: 1,
      });
    } else {
      dup.timesObserved = (dup.timesObserved || 1) + 1;
    }
    rb.lastUpdated = new Date().toISOString();
    safeWrite(RULE_BOOK_PATH, rb);
  }

  // For EQIS-side issues with high confidence, file a tech proposal so the team
  // (or FRAKA's coder) can review and apply the fix.
  if (verdict.side === 'eqis' && verdict.confidence === 'high' && verdict.eqisFixSuggestion) {
    try {
      proposalsStore.createProposal({
        type: 'code-fix',
        audience: 'tech',
        priority: 'P1',
        description: 'AUDIT (' + search.searchId + '): ' + verdict.rootCause +
          ' — Suggested fix: ' + verdict.eqisFixSuggestion +
          ' — Affected file: ' + (verdict.affectedFile || 'unknown'),
        evidence: 'Vision audit of search ' + search.searchId + ' (' + (search.label || '') + '). ' + verdict.evidence,
      }, 'fraka-failure-auditor');
    } catch (err) {
      logger.warn('[FRAKA-AUDIT] Failed to create proposal: ' + err.message);
    }
  }
}

/**
 * Public entry — run one audit cycle. Audits up to MAX_AUDITS_PER_RUN unaudited failures.
 */
async function runAuditCycle({ hoursBack = 6, maxAudits = MAX_AUDITS_PER_RUN } = {}) {
  const failures = listUnauditedFailures(hoursBack);
  if (failures.length === 0) {
    logger.info('[FRAKA-AUDIT] No unaudited failures in last ' + hoursBack + 'h');
    return { audited: 0, totalCandidates: 0, perSearch: [] };
  }

  const batch = failures.slice(0, maxAudits);
  logger.info('[FRAKA-AUDIT] Auditing ' + batch.length + ' of ' + failures.length + ' unaudited failures');

  const results = [];
  for (const search of batch) {
    try {
      const verdict = await auditOneSearch(search);
      persistFinding(search, verdict);
      results.push({ searchId: search.searchId, label: search.label, verdict });
      logger.info('[FRAKA-AUDIT] ' + search.searchId + ' (' + (search.label || '') + ') → ' + verdict.side + ' [' + verdict.confidence + '] — ' + verdict.rootCause);
    } catch (err) {
      logger.error('[FRAKA-AUDIT] Failed to audit ' + search.searchId + ': ' + err.message);
    }
  }

  return {
    audited: results.length,
    totalCandidates: failures.length,
    skipped: failures.length - results.length,
    perSearch: results,
  };
}

module.exports = {
  runAuditCycle,
  listUnauditedFailures,
  loadRuleBook,
  loadFindings,
};
