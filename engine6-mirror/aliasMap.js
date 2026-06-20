// aliasMap.js — Normalization dictionaries for room categories and meal plans.
//
// Eagle Crest's ECD inventory and Etrav's normal hotel search inventory often
// label the same logical concept differently (e.g. "CP" vs "Breakfast",
// "Deluxe Room" vs "Dlx Room"). This map lets combinationMatcher.js compare
// across both sides fairly.

// Canonical meal plan codes
const MEAL_CANONICAL = {
  RO:  ['ro', 'room only', 'no meals', 'european plan', 'ep'],
  CP:  ['cp', 'continental plan', 'breakfast', 'breakfast only', 'with breakfast', 'bb', 'bed and breakfast', 'bed & breakfast'],
  MAP: ['map', 'modified american plan', 'half board', 'hb', 'breakfast and dinner', 'breakfast + dinner'],
  AP:  ['ap', 'american plan', 'full board', 'fb', 'all meals', 'three meals', '3 meals'],
  AI:  ['ai', 'all inclusive', 'all-inclusive'],
};

// Canonical room category buckets (lowercase keywords matched against the
// normalized room name). First match wins — order matters for specificity.
const ROOM_BUCKETS = [
  { canonical: 'PRESIDENTIAL', keywords: ['presidential'] },
  { canonical: 'SUITE',        keywords: ['suite'] },
  { canonical: 'VILLA',        keywords: ['villa', 'pool villa'] },
  { canonical: 'COTTAGE',      keywords: ['cottage', 'cabin'] },
  { canonical: 'EXECUTIVE',    keywords: ['executive', 'club', 'business'] },
  { canonical: 'PREMIUM',      keywords: ['premium', 'premier'] },
  { canonical: 'DELUXE',       keywords: ['deluxe', 'dlx', 'superior deluxe'] },
  { canonical: 'SUPERIOR',     keywords: ['superior', 'sup'] },
  { canonical: 'STANDARD',     keywords: ['standard', 'std', 'classic', 'basic'] },
];

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalMealPlan(raw) {
  const norm = normalizeText(raw);
  if (!norm) return null;
  for (const [canonical, aliases] of Object.entries(MEAL_CANONICAL)) {
    if (aliases.some((a) => norm === a || norm.includes(a))) return canonical;
  }
  return null;
}

function canonicalRoomCategory(raw) {
  const norm = normalizeText(raw);
  if (!norm) return null;
  for (const bucket of ROOM_BUCKETS) {
    if (bucket.keywords.some((k) => norm.includes(k))) return bucket.canonical;
  }
  return null;
}

module.exports = {
  normalizeText,
  canonicalMealPlan,
  canonicalRoomCategory,
  MEAL_CANONICAL,
  ROOM_BUCKETS,
};
