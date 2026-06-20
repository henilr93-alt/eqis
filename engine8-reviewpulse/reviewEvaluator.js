// reviewEvaluator.js — Classify the outcome of one Review Pulse attempt
// into one of the buckets below. Pure function for easy testing.

const VERDICTS = {
  REVIEW_OK:           'REVIEW_OK',           // page loaded cleanly, passenger form present
  BOOK_BTN_MISSING:    'BOOK_BTN_MISSING',    // could not find the Book button on results
  BOOK_CLICK_NO_NAV:   'BOOK_CLICK_NO_NAV',   // clicked Book but URL didn't change
  REVIEW_LOAD_TIMEOUT: 'REVIEW_LOAD_TIMEOUT', // review page DOM never settled in time
  PRICE_CHANGED:       'PRICE_CHANGED',       // Etrav modal "Price has changed from \u20b9X to \u20b9Y"
  FARE_UNAVAILABLE:    'FARE_UNAVAILABLE',    // "This fare is no longer available"
  SESSION_EXPIRED:     'SESSION_EXPIRED',     // kicked back to login
  BANNER_ERROR:        'BANNER_ERROR',        // red banner with an error message
  FARE_CHANGE:         'FARE_CHANGE',         // Etrav "Fare Change Alert" modal — fare increased/decreased after load (ETRAV-side, informational)
  SOLD_OUT:            'SOLD_OUT',            // Etrav "Flight Not Available — has sold out since you made your selection" modal after Book Now (ETRAV-side)
  JS_ERROR:            'JS_ERROR',            // uncaught JS error during navigation
  REVIEW_BROKEN:       'REVIEW_BROKEN',       // generic — review page didn't render a passenger form
  FAILED_TO_LOAD:      'FAILED_TO_LOAD',      // ETRAV-SIDE: review page never finished rendering (passenger form + continue button absent after 12s retry) — this is the core product-quality signal Review Pulse exists to catch
  RESULTS_NOT_LOADED:  'RESULTS_NOT_LOADED',  // ETRAV-SIDE: search-results page never populated flight rows after the polling window (or rows visible but no parseable combos)
};

/**
 * Evaluate a captured Review Pulse attempt and return a verdict + severity.
 *
 * @param {Object} ctx { stage, error, metrics, sector, target }
 *   stage   = 'BOOK_FIND' | 'BOOK_CLICK' | 'NAV' | 'CAPTURED'
 *   error   = error message if any
 *   metrics = output of reviewPageExtractor.extract (when captured)
 * @returns {{ verdict, severity }}
 */
function evaluate(ctx) {
  if (!ctx) return { verdict: VERDICTS.REVIEW_BROKEN, severity: 'P2' };
  if (ctx.stage === 'BOOK_FIND')  return { verdict: VERDICTS.BOOK_BTN_MISSING,  severity: 'P1' };
  if (ctx.stage === 'BOOK_CLICK') return { verdict: VERDICTS.BOOK_CLICK_NO_NAV, severity: 'P1' };
  if (ctx.stage === 'NAV')        return { verdict: VERDICTS.REVIEW_LOAD_TIMEOUT, severity: 'P1' };

  const m = ctx.metrics || {};
  const url = m.url || '';
  if (/login|signin/i.test(url)) return { verdict: VERDICTS.SESSION_EXPIRED, severity: 'P1' };

  // SOLD_OUT: Etrav shows a "Flight Not Available / has sold out since you made
  // your selection" modal after Book Now. Tag it distinctly (NOT FAILED_TO_LOAD).
  // Scan the page body because this modal is often missed by the banner selector.
  const _bodyText = (m.reviewBodyFull || m.reviewBodySample || '');
  if (/flight not available|no longer available|has sold out|sold out since you made|choose a different flight/i.test(_bodyText)) return { verdict: VERDICTS.SOLD_OUT, severity: 'P2' };

  const banners = m.errorBanners || [];
  for (const b of banners) {
    if (/fare\s*change\s*alert|airfares?\s*are\s*dynamic|fare\s*of\s*the\s*selected\s*flight\s*has\s*(?:decreased|increased|changed)/i.test(b)) return { verdict: VERDICTS.FARE_CHANGE, severity: 'P2' };
    if (/price\s*has\s*changed/i.test(b)) return { verdict: VERDICTS.PRICE_CHANGED, severity: 'P2' };
    if (/(no longer available|sold out|fare\s*unavailable)/i.test(b)) return { verdict: VERDICTS.FARE_UNAVAILABLE, severity: 'P1' };
    if (/(session\s*expired|please\s*login)/i.test(b)) return { verdict: VERDICTS.SESSION_EXPIRED, severity: 'P1' };
  }
  if (banners.length > 0) return { verdict: VERDICTS.BANNER_ERROR, severity: 'P2' };

  if (!m.hasPassengerForm) return { verdict: VERDICTS.REVIEW_BROKEN, severity: 'P1' };
  return { verdict: VERDICTS.REVIEW_OK, severity: null };
}

module.exports = { evaluate, VERDICTS };
