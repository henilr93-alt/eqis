// verdictRules.js — Pure functions that classify a single comparison row.
//
// Inputs are deterministic; no Playwright, no I/O. Easy to unit-test.

const settings = require('../config/settings');

const VERDICTS = {
  ECD_CHEAPER:       'ECD_CHEAPER',
  NORMAL_CHEAPER:    'NORMAL_CHEAPER',
  EQUAL:             'EQUAL',
  DEFAULT_STOCKOUT:  'DEFAULT_STOCKOUT',
  COMBO_UNMATCHED:   'COMBO_UNMATCHED',
  ECD_BROKEN:        'ECD_BROKEN',
  // 2026-06-12: When one side's stored price looks like a per-night rate
  // mistakenly scraped as totalPrice (ratio close to nights × rooms),
  // the comparator flags the row with this verdict instead of computing
  // a real ECD vs NORMAL_CHEAPER diff. Suppressed from team digests so
  // Sudhir / Marketing don't act on contaminated data. FRAKA investigates.
  SUSPECT_PRICE_UNIT:'SUSPECT_PRICE_UNIT',
};

/**
 * Classify a paired ECD + normal combo by total price.
 *
 * @param {number} ecdPrice
 * @param {number} normalPrice
 * @returns {{verdict, absINR, pct, cheaperSide, severity}}
 */
function priceVerdict(ecdPrice, normalPrice) {
  const absINR = Math.round((ecdPrice - normalPrice) * 100) / 100; // 2dp
  const pct = normalPrice > 0
    ? Math.round(((ecdPrice - normalPrice) / normalPrice) * 10000) / 100  // 2dp pct
    : 0;

  const equalThr = settings.ECD_EQUAL_THRESHOLD_PCT || 2;
  const normalP1Thr = settings.ECD_NORMAL_CHEAPER_P1_PCT || 10;

  if (Math.abs(pct) <= equalThr) {
    return { verdict: VERDICTS.EQUAL, absINR, pct, cheaperSide: 'EQUAL', severity: null };
  }
  if (ecdPrice < normalPrice) {
    return { verdict: VERDICTS.ECD_CHEAPER, absINR, pct, cheaperSide: 'ECD', severity: null };
  }
  // normal is cheaper
  const severity = pct >= normalP1Thr ? 'P1' : null;
  return { verdict: VERDICTS.NORMAL_CHEAPER, absINR, pct, cheaperSide: 'NORMAL', severity };
}

/**
 * Top-level verdict for a hotel-level row when we couldn't even get to pricing.
 */
function nonPriceVerdict(kind) {
  switch (kind) {
    case 'DEFAULT_STOCKOUT': return { verdict: VERDICTS.DEFAULT_STOCKOUT, severity: 'P1' };
    case 'COMBO_UNMATCHED':  return { verdict: VERDICTS.COMBO_UNMATCHED,  severity: null };
    case 'ECD_BROKEN':       return { verdict: VERDICTS.ECD_BROKEN,       severity: 'P0' };
    default:                 return { verdict: kind || 'UNKNOWN',         severity: null };
  }
}

module.exports = { priceVerdict, nonPriceVerdict, VERDICTS };
