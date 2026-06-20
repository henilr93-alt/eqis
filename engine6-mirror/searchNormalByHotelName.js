// searchNormalByHotelName.js — On the regular /hotels page, type a specific
// hotel name into the destination autosuggest, pick the hotel-type suggestion
// (not city), fill dates, and submit. Returns the page so the caller can read
// listings or open the hotel detail.
//
// This is the "search by exact ECD hotel name" approach the user confirmed
// works manually — autosuggest finds the hotel even when the names differ in
// spacing/casing.

const logger = require('../utils/logger');
const settings = require('../config/settings');
const screenshotter = require('../utils/screenshotter');
const { pickHotelDateRange, dismissAllOverlays, fillHotelPax } = require('../utils/etravFormHelpers');
const { hotelNameScore } = require('./combinationMatcher');

const PLACEHOLDER = 'Hotel name or Destination';
const SUGGESTION_SELECTORS = [
  '.react-autosuggest__suggestion',
  '[role="option"]',
];

const LISTING_CARD_SELECTORS = [
  '.listingCard',
  '[class*="listingCard"]',
  '.listing-container',
];

async function clickSearchHotelButton(page) {
  return page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.offsetParent !== null && /search\s*hotel/i.test((b.textContent || '').trim()) && !b.disabled);
    if (btn) { btn.scrollIntoView({ block: 'center', behavior: 'instant' }); btn.click(); return true; }
    return false;
  });
}

async function waitForListing(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await page.evaluate((sels) => {
      let c = 0;
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          if ((el.textContent || '').trim().length > 50) c++;
        }
      }
      return c;
    }, LISTING_CARD_SELECTORS).catch(() => 0);
    if (n > 0) { await page.waitForTimeout(2000); return true; }
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Type a hotel name into the /hotels autosuggest and pick the hotel-type
 * suggestion that best matches the name. Returns the picked text and score.
 *
 * Suggestions look like:
 *   "Best Western Premier Sonasea Phu QuocBest Western Premier Sonasea Phu Quoc, Phu Quoc, Kien Giang, VNHotel"
 * Hotel-type entries end with "Hotel" (vs City/destination entries which don't).
 */
async function typeAndPickHotelSuggestion(page, hotelName) {
  const input = await page.$('input[placeholder="' + PLACEHOLDER + '"]') ||
                await page.$('input.react-autosuggest__input');
  if (!input) return { picked: false, reason: 'autosuggest input not found' };

  await input.click({ force: true });
  await page.waitForTimeout(300);
  await input.fill('');
  await page.waitForTimeout(300);
  await input.type(hotelName, { delay: 60 });
  await page.waitForTimeout(1800); // let Etrav's debounced suggestion API respond

  // Wait briefly for any suggestion to appear
  const sawSuggestion = await page.waitForSelector(SUGGESTION_SELECTORS.join(','), { timeout: 8000 })
    .then(() => true).catch(() => false);
  if (!sawSuggestion) {
    return { picked: false, reason: 'no suggestions appeared for "' + hotelName + '"' };
  }

  await page.waitForTimeout(500); // let the list fully populate

  // Collect visible suggestions and score them
  const suggestions = await page.evaluate((sels) => {
    for (const sel of sels) {
      const items = Array.from(document.querySelectorAll(sel))
        .filter((el) => el.offsetParent !== null);
      if (items.length > 0) {
        return items.map((el, idx) => ({
          idx, selector: sel,
          text: (el.textContent || '').trim().slice(0, 300),
        }));
      }
    }
    return [];
  }, SUGGESTION_SELECTORS);

  if (suggestions.length === 0) {
    return { picked: false, reason: 'suggestion list rendered empty' };
  }

  // Prefer suggestions ending with "Hotel" (hotel-type entries).
  // Score by hotelNameScore against the typed name; tiebreak by hotel-type suffix.
  const ranked = suggestions.map((s) => {
    // The displayed text is repeated and then followed by location + "Hotel" or "City"
    const isHotelType = /Hotel\s*$/i.test(s.text);
    const score = hotelNameScore(hotelName, s.text);
    return { ...s, isHotelType, score };
  }).sort((a, b) => {
    if (a.isHotelType !== b.isHotelType) return a.isHotelType ? -1 : 1;
    return b.score - a.score;
  });

  const best = ranked[0];
  if (!best || best.score < 0.35) {
    return { picked: false, reason: 'best suggestion "' + (best?.text || '').slice(0, 60) + '" scored ' + (best?.score || 0).toFixed(2) };
  }

  // Click the nth suggestion via Playwright (real mouse events for React)
  const handles = await page.$$(best.selector);
  if (!handles[best.idx]) return { picked: false, reason: 'suggestion handle lost' };
  try {
    await handles[best.idx].click({ force: true, timeout: 5000 });
  } catch (e) {
    // Fallback: bbox click
    const box = await handles[best.idx].boundingBox().catch(() => null);
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    else return { picked: false, reason: 'click failed: ' + e.message };
  }
  await page.waitForTimeout(700);

  return {
    picked: true,
    suggestionText: best.text,
    score: best.score,
    isHotelType: best.isHotelType,
  };
}

/**
 * Full flow: navigate to /hotels, type hotel name, pick hotel suggestion,
 * fill dates, submit, wait for listings. Returns { status, pageUrl, ... }.
 */
async function searchNormalByHotelName(page, opts) {
  const { hotelName, checkin, checkout, runId } = opts;
  // 2026-06-09: Per-room-per-night Fix A — accept adults/rooms and verify the
  // /hotels form's pax matches the ECD scenario. Without this, the form
  // defaults (or a session-remembered pax from a prior search) silently
  // change the market total and make per-night comparison apples-to-oranges.
  // Default to 1R/2A (matches the ECD pax lock per CEO Directive #2).
  const adults = Math.max(1, Number(opts.adults || 2));
  const rooms  = Math.max(1, Number(opts.rooms  || 1));
  const result = {
    hotelName,
    status: 'PENDING',
    pickedSuggestion: null,
    pickScore: 0,
    pageUrl: null,
    screenshotPath: null,
    error: null,
    loadTimeMs: 0,
  };

  const t0 = Date.now();
  try {
    const baseUrl = settings.ETRAV_BASE_URL.replace(/\/$/, '');
    await page.goto(baseUrl + '/hotels', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await dismissAllOverlays(page).catch(() => {});

    const pick = await typeAndPickHotelSuggestion(page, hotelName);
    if (!pick.picked) {
      result.status = 'AUTOSUGGEST_FAILED';
      result.error = pick.reason;
      return result;
    }
    result.pickedSuggestion = pick.suggestionText;
    result.pickScore = pick.score;

    const datesOk = await pickHotelDateRange(page, new Date(checkin), new Date(checkout));
    if (!datesOk) {
      result.status = 'DATE_PICKER_FAILED';
      result.error = 'Could not fill check-in / check-out dates';
      return result;
    }

    // 2026-06-09: Pax symmetry — match ECD's pattern from ecdHotelSearcher.js
    // lines 518-534. Read the displayed "N Room / N Guests" pill; if it does
    // not already equal the requested config, click the pax dropdown and
    // fill it explicitly. We deliberately SKIP the click when it already
    // matches (mirrors the ECD page-drift avoidance — fillHotelPax is known
    // to sometimes navigate away from the form).
    const paxAlreadyMatches = await page.evaluate(({ rooms, adults }) => {
      const text = (document.body.innerText || '').toLowerCase();
      // Etrav pill text formats observed: "1 Room / 2 Guests", "1 Room • 2 Adults".
      const roomToken  = rooms  + ' room';
      const guestToken = adults + ' guest';
      const adultToken = adults + ' adult';
      return text.includes(roomToken) && (text.includes(guestToken) || text.includes(adultToken));
    }, { rooms, adults }).catch(() => false);

    if (!paxAlreadyMatches) {
      const roomPax = Array.from({ length: rooms }, () => ({
        adults: Math.max(1, Math.ceil(adults / rooms)),
        children: [],
      }));
      logger.info('[MIRROR] Pax default does not match ' + rooms + 'R/' + adults + 'A — correcting');
      await fillHotelPax(page, rooms, roomPax).catch((e) => {
        logger.warn('[MIRROR] fillHotelPax warning (continuing): ' + e.message);
      });
    } else {
      logger.info('[MIRROR] Pax default already matches ' + rooms + 'R/' + adults + 'A — skipping fill');
    }

    const clicked = await clickSearchHotelButton(page);
    if (!clicked) {
      result.status = 'SUBMIT_BUTTON_NOT_FOUND';
      result.error = 'Search Hotel button not found';
      return result;
    }

    await page.waitForFunction(() => /\/hotels\/search-results/.test(window.location.pathname),
      { timeout: 25000 }).catch(() => {});
    result.pageUrl = page.url();

    const listingOk = await waitForListing(page, 90000);
    if (!listingOk) {
      result.status = 'NO_RESULTS_RENDERED';
      result.error = 'Listing cards did not render after autosuggest hotel search';
      return result;
    }
    result.status = 'OK';
  } catch (err) {
    result.status = 'ERROR';
    result.error = err.message;
  } finally {
    result.loadTimeMs = Date.now() - t0;
    try {
      const shot = await screenshotter.takeStep(page, runId, 'mirror-name-' + (hotelName || '').replace(/\s+/g, '_').slice(0, 40));
      if (shot) result.screenshotPath = shot;
    } catch { /* ignore */ }
  }

  return result;
}

module.exports = { searchNormalByHotelName, typeAndPickHotelSuggestion };
