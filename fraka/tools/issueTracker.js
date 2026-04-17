// Persistent issue tracker — maintains firstSeen/lastSeen timestamps for each
// unique pain-point fingerprint so FRAKA can report "issue X has been persistent
// for Y days" to the CEO.
//
// Fingerprint = category + '|' + subcategory + '|' + normalized(title)
// Stored in state/fraka/painPoints.json under issueFingerprints{}.

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const PAIN_POINTS_PATH = path.join(__dirname, '..', '..', 'state', 'fraka', 'painPoints.json');

function loadStore() {
  try { return JSON.parse(fs.readFileSync(PAIN_POINTS_PATH, 'utf-8')); }
  catch { return { issueFingerprints: {}, painPoints: [], lastUpdatedAt: null }; }
}

function saveStore(store) {
  fs.writeFileSync(PAIN_POINTS_PATH, JSON.stringify(store, null, 2));
}

function normalize(s) {
  return (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
}

function fingerprint(category, subcategory, title) {
  return `${normalize(category)}|${normalize(subcategory)}|${normalize(title)}`;
}

/**
 * Register or update an issue sighting. Called by the pain-point analyzer
 * for every issue it detects in the current analysis window.
 * @returns the issueFingerprint record { fp, firstSeen, lastSeen, occurrences }
 */
function recordSighting(category, subcategory, title, timestamp = new Date().toISOString()) {
  const store = loadStore();
  if (!store.issueFingerprints) store.issueFingerprints = {};

  const fp = fingerprint(category, subcategory, title);
  const existing = store.issueFingerprints[fp];

  if (existing) {
    existing.lastSeen = timestamp;
    existing.occurrences = (existing.occurrences || 0) + 1;
  } else {
    store.issueFingerprints[fp] = {
      fp,
      category,
      subcategory,
      title,
      firstSeen: timestamp,
      lastSeen: timestamp,
      occurrences: 1,
    };
  }

  saveStore(store);
  return store.issueFingerprints[fp];
}

/**
 * Mark issues as resolved if they haven't been seen in the last `thresholdHours`.
 */
function markStaleAsResolved(thresholdHours = 24) {
  const store = loadStore();
  const cutoff = new Date(Date.now() - thresholdHours * 3600 * 1000);
  let marked = 0;
  for (const fp in (store.issueFingerprints || {})) {
    const rec = store.issueFingerprints[fp];
    if (!rec.resolved && new Date(rec.lastSeen) < cutoff) {
      rec.resolved = true;
      rec.resolvedAt = new Date().toISOString();
      marked++;
    }
  }
  if (marked > 0) {
    saveStore(store);
    logger.info(`[FRAKA] Marked ${marked} stale issues as resolved`);
  }
  return marked;
}

function getFingerprintRecord(category, subcategory, title) {
  const store = loadStore();
  return store.issueFingerprints?.[fingerprint(category, subcategory, title)] || null;
}

function daysPersistent(record) {
  if (!record || !record.firstSeen) return 0;
  const firstSeen = new Date(record.firstSeen);
  const lastSeen = new Date(record.lastSeen || record.firstSeen);
  const ms = lastSeen - firstSeen;
  return Math.max(0, Math.round(ms / (86400 * 1000) * 10) / 10); // 1 decimal place
}

function hoursPersistent(record) {
  if (!record || !record.firstSeen) return 0;
  const firstSeen = new Date(record.firstSeen);
  const lastSeen = new Date(record.lastSeen || record.firstSeen);
  return Math.max(0, Math.round((lastSeen - firstSeen) / (3600 * 1000) * 10) / 10);
}

module.exports = {
  recordSighting,
  markStaleAsResolved,
  getFingerprintRecord,
  daysPersistent,
  hoursPersistent,
  fingerprint,
  loadStore,
  saveStore,
};
