// combinationMatcher.js — Normalized fuzzy matching for ECD vs normal hotels.

const { canonicalMealPlan, canonicalRoomCategory, normalizeText } = require('./aliasMap');

function tokenJaccard(a, b) {
  const A = new Set(normalizeText(a).split(' ').filter(Boolean));
  const B = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

// Extract bedroom count from a room name. "One Bedroom Suite" -> 1,
// "Suite, 2 Bedroom, Quadruple" -> 2, "Deluxe Room" -> null (not specified).
// Returns null when no bedroom count is mentioned (so we don't force a mismatch
// on rooms that simply don't talk about bedroom count).
const WORD_TO_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
function bedroomCount(roomName) {
  const s = String(roomName || '').toLowerCase();
  // numeric form: "2 bedroom", "2-bedroom", "2 bed "
  let m = s.match(/(\d+)\s*-?\s*(bedroom|bed\s)/);
  if (m) return parseInt(m[1], 10);
  // word form: "two bedroom", "one-bedroom"
  m = s.match(/\b(one|two|three|four|five|six)\s*-?\s*(bedroom|bed\s)/);
  if (m) return WORD_TO_NUM[m[1]];
  return null;
}

// 2026-06-09: extract the view category from a room name. Mirrors the
// bedroom-count guard's design — returns null when no view is declared
// (e.g. "Deluxe Room") so we don't force a mismatch on rooms that simply
// don't talk about view. Categories are coarse-grouped so synonyms align
// (ocean ↔ sea, lagoon ↔ river, courtyard ↔ garden).
const VIEW_GROUPS = {
  sea:       ['sea', 'ocean', 'beach', 'beachfront', 'oceanfront', 'seafront'],
  pool:      ['pool', 'poolside', 'lagoon pool', 'pool view'],
  garden:    ['garden', 'tropical', 'courtyard', 'park'],
  mountain:  ['mountain', 'hill', 'valley'],
  river:     ['river', 'lagoon', 'lake', 'canal', 'waterway'],
  city:      ['city', 'street', 'urban', 'skyline'],
  interior:  ['interior', 'inside', 'no view'],
};
function viewType(roomName) {
  const s = String(roomName || '').toLowerCase();
  for (const [group, syns] of Object.entries(VIEW_GROUPS)) {
    for (const w of syns) {
      // Match "<word> view" OR "<word>view" OR ", <word>, ...View"
      if (new RegExp('\\b' + w + '\\s*view\\b').test(s)) return group;
      if (new RegExp('\\b' + w + 'view\\b').test(s))    return group;
    }
  }
  // Fall-through: some rooms say "view" without a category — that's null too
  return null;
}

// 2026-06-10: extract the occupancy category from a room name. Mirrors the
// bedroom-count + view guards' design — returns null when no occupancy is
// declared (e.g. "Deluxe Garden" alone) so we don't force a mismatch on
// rooms that simply don't talk about occupancy.
//
// Why this exists: ECD "Deluxe Garden" (2-pax) was matching market
// "Deluxe, Triple" (3-pax) because both canonicalize to "Deluxe" and the
// market room declared no view. That false-positive turned a different
// product into a fake 71% saving on Jambuluwuk Oceano (run ECD-20260609-1600).
//
// Categories collapse synonyms by pax count, NOT bed configuration —
// "Double" and "Twin" both mean 2-pax, so they share a group. "Double or
// Twin" is the literal Etrav alias for the same 2-pax product.
const OCCUPANCY_GROUPS = {
  single: ['single'],
  double: ['double', 'twin', 'double or twin', 'matrimonial'],
  triple: ['triple'],
  quad:   ['quad', 'quadruple'],
  family: ['family'],
};
function occupancyType(roomName) {
  const s = ' ' + String(roomName || '').toLowerCase() + ' ';
  // Order matters — check the more specific multi-word aliases first
  // ("double or twin" before "double" / "twin" so we don't double-match).
  if (/\bdouble\s+or\s+twin\b/.test(s)) return 'double';
  for (const [group, syns] of Object.entries(OCCUPANCY_GROUPS)) {
    for (const w of syns) {
      if (w === 'double or twin') continue; // handled above
      if (new RegExp('\\b' + w + '\\b').test(s)) return group;
    }
  }
  return null;
}

function roomMatches(ecdRoom, normalRoom) {
  // Reject mismatches on bedroom count (e.g. "One Bedroom Suite" must NOT
  // match "Suite, 2 Bedroom, Quadruple"). Only enforce when BOTH sides
  // declare a count — if one side is silent, we let canonical matching decide.
  const ecdBeds = bedroomCount(ecdRoom);
  const normBeds = bedroomCount(normalRoom);
  if (ecdBeds != null && normBeds != null && ecdBeds !== normBeds) return 0;

  // 2026-06-09: same idea for view category. A Sea-View room is a different
  // product than a Garden-View room (different revenue, different inventory).
  // Only enforce when BOTH sides declare a view category.
  const ecdView = viewType(ecdRoom);
  const normView = viewType(normalRoom);
  if (ecdView && normView && ecdView !== normView) return 0;

  // 2026-06-10: occupancy guard. A 2-pax Double/Twin room is a different
  // product than a 3-pax Triple or 4-pax Quad.
  //
  // Unlike the bedroom + view guards, this one is ASYMMETRIC by intent:
  // when only ONE side declares an occupancy, we treat the silent side as
  // "double" (the implicit default in every hotel listing — silent rooms
  // are virtually always 2-pax). This catches the Jambuluwuk false-positive
  // where ECD "Deluxe Garden" (silent → 2-pax) was matched to market
  // "Deluxe, Triple" (3-pax) just because both canonicalize to "Deluxe".
  const DEFAULT_OCC = 'double';
  const ecdOccEff  = occupancyType(ecdRoom)    || DEFAULT_OCC;
  const normOccEff = occupancyType(normalRoom) || DEFAULT_OCC;
  if (ecdOccEff !== normOccEff) return 0;

  const ecdCan = canonicalRoomCategory(ecdRoom);
  const normCan = canonicalRoomCategory(normalRoom);
  if (ecdCan && normCan) return ecdCan === normCan ? 1.0 : 0;
  return tokenJaccard(ecdRoom, normalRoom) >= 0.6 ? 0.75 : 0;
}

function mealMatches(ecdMeal, normalMeal) {
  const ecdCan = canonicalMealPlan(ecdMeal);
  const normCan = canonicalMealPlan(normalMeal);
  if (ecdCan && normCan) return ecdCan === normCan ? 1.0 : 0;
  return tokenJaccard(ecdMeal, normalMeal) >= 0.6 ? 0.75 : 0;
}

function findBestComboMatch(ecdCombo, normalCombos) {
  if (!Array.isArray(normalCombos) || normalCombos.length === 0) return null;
  const candidates = normalCombos
    .map((nc) => {
      const roomScore = roomMatches(ecdCombo.roomCategory, nc.roomCategory);
      const mealScore = mealMatches(ecdCombo.mealPlan, nc.mealPlan);
      if (roomScore === 0 || mealScore === 0) return null;
      return { combo: nc, roomScore, mealScore, totalScore: (roomScore + mealScore) / 2 };
    })
    .filter(Boolean);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    const da = Math.abs((a.combo.totalPrice || 0) - (ecdCombo.totalPrice || 0));
    const db = Math.abs((b.combo.totalPrice || 0) - (ecdCombo.totalPrice || 0));
    return da - db;
  });
  return candidates[0];
}

function stripGenerics(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[,()].*$/g, ' ')
    .replace(/\b(hotel|hotels|resort|resorts|spa|inn|suite|suites|club|tower|towers|the|at|and|by|of|premier|premium|hotelhotel)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hotelNameScore(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.95;

  const sa = stripGenerics(a);
  const sb = stripGenerics(b);
  if (sa && sb) {
    if (sa === sb) return 0.95;
    if (sa.includes(sb) || sb.includes(sa)) return 0.9;
    const ta = new Set(sa.split(' ').filter((w) => w.length > 2));
    const tb = new Set(sb.split(' ').filter((w) => w.length > 2));
    if (ta.size > 0 && tb.size > 0) {
      let inter = 0;
      for (const t of ta) if (tb.has(t)) inter++;
      // Require at least 2 distinctive tokens in common OR all of the shorter
      // name is in the longer (which is the containment case above).
      // A single shared token is too generic (e.g. "Palace", "Garden").
      if (inter < 2) return 0;
      const minSize = Math.min(ta.size, tb.size);
      const overlap = minSize ? inter / minSize : 0;
      const union = ta.size + tb.size - inter;
      const jaccard = union ? inter / union : 0;
      return Math.max(jaccard, overlap * 0.85);
    }
  }
  return tokenJaccard(a, b);
}

module.exports = { findBestComboMatch, hotelNameScore, tokenJaccard, stripGenerics };
